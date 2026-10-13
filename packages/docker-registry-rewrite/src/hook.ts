import * as fs from 'fs'
import { spawn } from 'child_process'
import { RewriteConfig } from './config'
import { exchangeOidcToken } from './jfrog'
import { rewriteDockerfile, rewriteImage } from './rewrite'

export interface Registry {
  username?: string
  password?: string
  serverUrl: string
}

export interface HookInput {
  command: string
  responseFile?: string
  args?: any
  state?: any
}

export interface Transformed {
  input: HookInput
  token?: string
  tokenIsNew: boolean
  cleanup: Array<() => Promise<void>>
}

export interface Deps {
  exchange: (config: RewriteConfig) => Promise<string>
  dockerLogin: (registry: Registry) => Promise<void>
  dockerLogout: (registry: Registry) => Promise<void>
}

export const defaultDeps: Deps = {
  exchange: config => exchangeOidcToken(config.jfrog!),
  dockerLogin: registry =>
    runDocker(
      ['login', registry.serverUrl, '-u', registry.username ?? '', '--password-stdin'],
      registry.password ?? ''
    ),
  dockerLogout: registry => runDocker(['logout', registry.serverUrl])
}

function runDocker(args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit']
    })
    child.on('error', reject)
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed: ${code}`))
    )
    if (stdin !== undefined) {
      child.stdin!.end(stdin)
    }
  })
}

// Returns a copy of the hook input with image references (and credentials) redirected to the configured host.
export async function transformInput(
  original: HookInput,
  config: RewriteConfig,
  deps: Deps = defaultDeps
): Promise<Transformed> {
  const input: HookInput = JSON.parse(JSON.stringify(original))
  const result: Transformed = {
    input,
    token: input.state?.registryRewrite?.token,
    tokenIsNew: false,
    cleanup: []
  }

  // Credentials meant for the original registry must not be sent to the replacement host.
  const registryFor = async (
    existing?: Registry
  ): Promise<Registry | undefined> => {
    if (config.jfrog) {
      if (!result.token) {
        result.token = await deps.exchange(config)
        result.tokenIsNew = true
      }
      return {
        serverUrl: config.host,
        username: config.jfrog.user,
        password: result.token
      }
    }
    if (config.forwardCredentials && existing) {
      return { ...existing, serverUrl: config.host }
    }
    return undefined
  }

  const rewriteContainer = async (container: any): Promise<void> => {
    if (!container?.image) {
      return
    }
    const rewritten = rewriteImage(container.image, config)
    if (rewritten === container.image) {
      return
    }
    console.log(`Registry rewrite: ${container.image} -> ${rewritten}`)
    container.image = rewritten
    const registry = await registryFor(container.registry)
    if (registry) {
      container.registry = registry
    } else {
      delete container.registry
    }
  }

  const args = input.args
  if (input.command === 'prepare_job' && args) {
    await rewriteContainer(args.container)
    for (const service of args.services ?? []) {
      await rewriteContainer(service)
    }
  } else if (input.command === 'run_container_step' && args) {
    await rewriteContainer(args)
    if (args.dockerfile) {
      await rewriteDockerfileArg(args, config, registryFor, deps, result)
    }
  }
  return result
}

async function rewriteDockerfileArg(
  args: any,
  config: RewriteConfig,
  registryFor: (existing?: Registry) => Promise<Registry | undefined>,
  deps: Deps,
  result: Transformed
): Promise<void> {
  const source = fs.readFileSync(args.dockerfile, 'utf8')
  const rewritten = rewriteDockerfile(source, config)
  if (rewritten === source) {
    return
  }
  console.log(`Registry rewrite: rewrote FROM lines in ${args.dockerfile}`)

  // Written next to the original so the build context is unchanged.
  const temp = `${args.dockerfile}.registry-rewrite-${process.pid}`
  fs.writeFileSync(temp, rewritten)
  result.cleanup.push(async () => fs.rmSync(temp, { force: true }))
  args.dockerfile = temp

  // `docker build` has no per-command credentials in the original hook, so log in to the default config for the build.
  const registry = await registryFor(args.registry)
  if (registry) {
    await deps.dockerLogin(registry)
    result.cleanup.push(() => deps.dockerLogout(registry).catch(() => {}))
  }
}

export function patchResponseState(
  responseFile: string,
  token: string
): boolean {
  if (!responseFile || !fs.existsSync(responseFile)) {
    return false
  }
  const text = fs.readFileSync(responseFile, 'utf8').trim()
  if (!text) {
    return false
  }
  const response = JSON.parse(text)
  response.state = { ...(response.state ?? {}), registryRewrite: { token } }
  fs.writeFileSync(responseFile, JSON.stringify(response))
  return true
}

export function runOriginalHook(
  hookPath: string,
  stdin: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      stdio: ['pipe', 'inherit', 'inherit']
    })
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
    child.stdin.end(`${stdin}\n`)
  })
}
