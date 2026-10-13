import { loadConfig, RewriteConfig } from '../src/config'
import { rewriteDockerfile, rewriteImage, splitImage } from '../src/rewrite'

function config(env: NodeJS.ProcessEnv): RewriteConfig {
  const c = loadConfig(env)
  if (!c) {
    throw new Error('expected config')
  }
  return c
}

describe('splitImage', () => {
  it.each([
    ['node:22', 'docker.io', 'node:22'],
    ['user/app:1', 'docker.io', 'user/app:1'],
    ['ghcr.io/o/i:1', 'ghcr.io', 'o/i:1'],
    ['localhost:5000/a/b', 'localhost:5000', 'a/b'],
    ['registry-1.docker.io/library/node', 'docker.io', 'library/node'],
    ['mcr.microsoft.com/dotnet/sdk@sha256:abc', 'mcr.microsoft.com', 'dotnet/sdk@sha256:abc']
  ])('%s', (image, registry, path) => {
    expect(splitImage(image)).toEqual({ registry, path })
  })
})

describe('loadConfig', () => {
  it('is disabled without a host', () => {
    expect(loadConfig({})).toBeUndefined()
  })

  it('derives host from the JFrog url and enables OIDC', () => {
    const c = config({
      REGISTRY_REWRITE_JFROG_URL: 'https://acme.jfrog.io/',
      REGISTRY_REWRITE_JFROG_OIDC_PROVIDER: 'github'
    })
    expect(c.host).toBe('acme.jfrog.io')
    expect(c.jfrog).toEqual({
      url: 'https://acme.jfrog.io',
      provider: 'github',
      audience: undefined,
      user: 'github-actions'
    })
  })

  it('rejects malformed rules', () => {
    expect(() =>
      loadConfig({ REGISTRY_REWRITE_HOST: 'h', REGISTRY_REWRITE_RULES: '[1]' })
    ).toThrow(/JSON object/)
  })
})

describe('rewriteImage', () => {
  it('replaces the registry host when no rules are set', () => {
    const c = config({ REGISTRY_REWRITE_HOST: 'mirror.example.com' })
    expect(rewriteImage('ghcr.io/o/i:1', c)).toBe('mirror.example.com/o/i:1')
    expect(rewriteImage('node:22', c)).toBe('mirror.example.com/node:22')
  })

  it('applies per-registry prefixes and leaves unmatched registries alone', () => {
    const c = config({
      REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
      REGISTRY_REWRITE_RULES: JSON.stringify({
        'docker.io': 'docker-hub',
        'ghcr.io': '/ghcr/'
      })
    })
    expect(rewriteImage('node:22', c)).toBe('acme.jfrog.io/docker-hub/node:22')
    expect(rewriteImage('ghcr.io/o/i@sha256:abc', c)).toBe(
      'acme.jfrog.io/ghcr/o/i@sha256:abc'
    )
    expect(rewriteImage('mcr.microsoft.com/dotnet/sdk:9', c)).toBe(
      'mcr.microsoft.com/dotnet/sdk:9'
    )
  })

  it('uses the * rule as fallback', () => {
    const c = config({
      REGISTRY_REWRITE_HOST: 'h.io',
      REGISTRY_REWRITE_RULES: '{"*":"proxy"}'
    })
    expect(rewriteImage('quay.io/a/b', c)).toBe('h.io/proxy/a/b')
  })

  it('skips the target host and configured registries', () => {
    const c = config({
      REGISTRY_REWRITE_HOST: 'h.io',
      REGISTRY_REWRITE_SKIP: 'ghcr.io, docker.io'
    })
    expect(rewriteImage('h.io/x/y', c)).toBe('h.io/x/y')
    expect(rewriteImage('ghcr.io/x/y', c)).toBe('ghcr.io/x/y')
    expect(rewriteImage('node:22', c)).toBe('node:22')
  })
})

describe('rewriteDockerfile', () => {
  const c = config({
    REGISTRY_REWRITE_HOST: 'h.io',
    REGISTRY_REWRITE_RULES: '{"docker.io":"hub","ghcr.io":"ghcr"}'
  })

  it('rewrites base images but not stages, scratch or ARGs', () => {
    const input = [
      'ARG BASE=node:22',
      'FROM --platform=linux/amd64 ghcr.io/o/builder:1 AS build',
      'RUN make',
      'FROM build AS test',
      'FROM $BASE',
      'FROM scratch',
      'from alpine:3 as final',
      'COPY --from=build /out /out',
      ''
    ].join('\r\n')
    expect(rewriteDockerfile(input, c)).toBe(
      [
        'ARG BASE=node:22',
        'FROM --platform=linux/amd64 h.io/ghcr/o/builder:1 AS build',
        'RUN make',
        'FROM build AS test',
        'FROM $BASE',
        'FROM scratch',
        'from h.io/hub/alpine:3 as final',
        'COPY --from=build /out /out',
        ''
      ].join('\r\n')
    )
  })
})
