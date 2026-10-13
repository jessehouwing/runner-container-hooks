import { normalizeRegistry, RewriteConfig } from './config'

export interface ImageParts {
  registry: string
  path: string
}

// Same heuristic as the docker CLI: the first path component is a registry host only if it
// contains '.' or ':' or is 'localhost'. Everything else lives on Docker Hub.
export function splitImage(image: string): ImageParts {
  const slash = image.indexOf('/')
  if (slash > 0) {
    const first = image.substring(0, slash)
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      return {
        registry: normalizeRegistry(first),
        path: image.substring(slash + 1)
      }
    }
  }
  return { registry: 'docker.io', path: image }
}

export function rewriteImage(image: string, config: RewriteConfig): string {
  const { registry, path } = splitImage(image)
  if (registry === config.host || config.skip.has(registry)) {
    return image
  }

  const hasRules = Object.keys(config.rules).length > 0
  const prefix = config.rules[registry] ?? config.rules['*']
  if (hasRules && prefix === undefined) {
    return image
  }
  return `${config.host}/${prefix ? `${prefix}/` : ''}${path}`
}

const FROM_LINE = /^(\s*FROM\s+)((?:--\S+\s+)*)(\S+)(\s+AS\s+(\S+))?(.*)$/i

// Rewrites the base images of FROM instructions. Stage references, `scratch` and
// ARG-substituted images are left alone.
export function rewriteDockerfile(
  content: string,
  config: RewriteConfig
): string {
  const stages = new Set<string>()
  return content
    .split(/(\r?\n)/)
    .map(line => {
      const match = FROM_LINE.exec(line)
      if (!match) {
        return line
      }
      const [, from, flags, image, asClause, stage, rest] = match
      let result = line
      if (
        image.toLowerCase() !== 'scratch' &&
        !image.includes('$') &&
        !stages.has(image.toLowerCase())
      ) {
        result = `${from}${flags}${rewriteImage(image, config)}${asClause ?? ''}${rest}`
      }
      if (stage) {
        stages.add(stage.toLowerCase())
      }
      return result
    })
    .join('')
}
