import * as path from 'path'
import { loadConfig } from './config'
import { revokeToken } from './jfrog'
import {
  HookInput,
  patchResponseState,
  runOriginalHook,
  transformInput
} from './hook'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  // The runner (and the original hook) use the last line as the JSON payload.
  const lines = Buffer.concat(chunks)
    .toString('utf8')
    .split(/\r?\n/)
    .filter(line => line.trim())
  return lines[lines.length - 1] ?? ''
}

async function main(): Promise<number> {
  const line = await readStdin()
  const config = loadConfig()
  if (!config) {
    return runOriginalHook(
      process.env.REGISTRY_REWRITE_ORIGINAL_HOOK ??
        path.resolve(__dirname, '../../docker/dist/index.js'),
      line
    )
  }

  const original = JSON.parse(line) as HookInput
  const transformed = await transformInput(original, config)
  let code = 1
  try {
    code = await runOriginalHook(
      config.originalHook,
      JSON.stringify(transformed.input)
    )
  } finally {
    for (const cleanup of transformed.cleanup.reverse()) {
      await cleanup().catch(() => {})
    }
  }

  if (config.jfrog) {
    let revoke: string | undefined
    if (original.command === 'cleanup_job') {
      revoke = original.state?.registryRewrite?.token
    } else if (transformed.tokenIsNew && transformed.token) {
      const persisted =
        original.command === 'prepare_job' &&
        code === 0 &&
        patchResponseState(original.responseFile ?? '', transformed.token)
      // Tokens created by prepare_job live until cleanup_job; any other new token is single-use.
      revoke = persisted ? undefined : transformed.token
    }
    if (revoke) {
      try {
        const status = await revokeToken(config.jfrog, revoke)
        console.log(`Registry rewrite: revoked JFrog token (HTTP ${status})`)
      } catch (error) {
        console.log(`::warning::Registry rewrite: token revoke failed: ${error}`)
      }
    }
  }
  return code
}

main().then(
  code => process.exit(code),
  error => {
    console.error(`::error::${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
)
