import * as path from 'path'

export interface JfrogConfig {
  url: string
  provider: string
  audience?: string
  user: string
}

export interface RewriteConfig {
  host: string
  // source registry (or '*') -> repository path prefix on the target host
  rules: Record<string, string>
  skip: Set<string>
  forwardCredentials: boolean
  originalHook: string
  jfrog?: JfrogConfig
}

export function normalizeRegistry(registry: string): string {
  const r = registry.trim().toLowerCase()
  if (r === 'index.docker.io' || r === 'registry-1.docker.io') {
    return 'docker.io'
  }
  return r
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function hostFromUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
}

// Returns undefined when no target host is configured: the wrapper then passes everything through untouched.
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): RewriteConfig | undefined {
  const jfrogProvider = env.REGISTRY_REWRITE_JFROG_OIDC_PROVIDER
  const jfrogUrlRaw = env.REGISTRY_REWRITE_JFROG_URL
  const hostRaw = env.REGISTRY_REWRITE_HOST
  const host = hostRaw
    ? hostFromUrl(hostRaw)
    : jfrogUrlRaw
      ? hostFromUrl(jfrogUrlRaw)
      : ''
  if (!host) {
    return undefined
  }

  const rules: Record<string, string> = {}
  if (env.REGISTRY_REWRITE_RULES) {
    const parsed = JSON.parse(env.REGISTRY_REWRITE_RULES)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'REGISTRY_REWRITE_RULES must be a JSON object of source registry -> path prefix'
      )
    }
    for (const [source, prefix] of Object.entries(parsed)) {
      rules[source === '*' ? '*' : normalizeRegistry(source)] = trimSlashes(
        String(prefix)
      )
    }
  }

  const skip = new Set(
    (env.REGISTRY_REWRITE_SKIP ?? '')
      .split(',')
      .map(s => normalizeRegistry(s))
      .filter(Boolean)
  )

  const config: RewriteConfig = {
    host: host.toLowerCase(),
    rules,
    skip,
    forwardCredentials:
      (env.REGISTRY_REWRITE_FORWARD_CREDENTIALS ?? '').toLowerCase() === 'true',
    // lib/index.js -> packages/docker-registry-rewrite/lib -> packages/docker/dist/index.js
    originalHook:
      env.REGISTRY_REWRITE_ORIGINAL_HOOK ??
      path.resolve(__dirname, '../../docker/dist/index.js')
  }

  if (jfrogProvider) {
    config.jfrog = {
      url: (jfrogUrlRaw ?? `https://${host}`).replace(/\/+$/, ''),
      provider: jfrogProvider,
      audience: env.REGISTRY_REWRITE_JFROG_OIDC_AUDIENCE || undefined,
      user: env.REGISTRY_REWRITE_JFROG_USER || 'github-actions'
    }
  }
  return config
}
