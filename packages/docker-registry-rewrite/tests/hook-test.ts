import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadConfig, RewriteConfig } from '../src/config'
import {
  Deps,
  patchResponseState,
  runOriginalHook,
  transformInput
} from '../src/hook'
import { exchangeOidcToken, revokeToken } from '../src/jfrog'

const cfg = (env: NodeJS.ProcessEnv): RewriteConfig =>
  loadConfig(env) as RewriteConfig

const makeDeps = (): jest.Mocked<Deps> => ({
  exchange: jest.fn().mockResolvedValue('jfrog-token'),
  dockerLogin: jest.fn().mockResolvedValue(undefined),
  dockerLogout: jest.fn().mockResolvedValue(undefined)
})

const prepareJob = (state?: any) => ({
  command: 'prepare_job',
  responseFile: '/tmp/r.json',
  state,
  args: {
    container: {
      image: 'ghcr.io/o/job:1',
      registry: { serverUrl: 'ghcr.io', username: 'u', password: 'original-secret' }
    },
    services: [{ contextName: 'db', image: 'postgres:16' }, { contextName: 'x', image: 'mcr.microsoft.com/a:1' }]
  }
})

describe('transformInput', () => {
  const base = cfg({
    REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
    REGISTRY_REWRITE_RULES: '{"ghcr.io":"ghcr","docker.io":"hub"}'
  })

  it('rewrites job and service images and drops the original credentials', async () => {
    const deps = makeDeps()
    const original = prepareJob()
    const t = await transformInput(original, base, deps)
    expect(t.input.args.container.image).toBe('acme.jfrog.io/ghcr/o/job:1')
    expect(t.input.args.container.registry).toBeUndefined()
    expect(t.input.args.services[0].image).toBe('acme.jfrog.io/hub/postgres:16')
    expect(t.input.args.services[1].image).toBe('mcr.microsoft.com/a:1')
    expect(JSON.stringify(t.input)).not.toContain('original-secret')
    expect(original.args.container.image).toBe('ghcr.io/o/job:1')
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  it('forwards credentials to the new host only when asked', async () => {
    const c = cfg({
      REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
      REGISTRY_REWRITE_FORWARD_CREDENTIALS: 'true'
    })
    const t = await transformInput(prepareJob(), c, makeDeps())
    expect(t.input.args.container.registry).toEqual({
      serverUrl: 'acme.jfrog.io',
      username: 'u',
      password: 'original-secret'
    })
  })

  describe('with JFrog OIDC', () => {
    const jf = cfg({
      REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
      REGISTRY_REWRITE_RULES: '{"ghcr.io":"ghcr","docker.io":"hub"}',
      REGISTRY_REWRITE_JFROG_OIDC_PROVIDER: 'github'
    })

    it('exchanges one token for all rewritten images', async () => {
      const deps = makeDeps()
      const t = await transformInput(prepareJob(), jf, deps)
      expect(deps.exchange).toHaveBeenCalledTimes(1)
      expect(t.tokenIsNew).toBe(true)
      expect(t.token).toBe('jfrog-token')
      for (const c of [t.input.args.container, t.input.args.services[0]]) {
        expect(c.registry).toEqual({
          serverUrl: 'acme.jfrog.io',
          username: 'github-actions',
          password: 'jfrog-token'
        })
      }
      expect(t.input.args.services[1].registry).toBeUndefined()
    })

    it('reuses the token stored in hook state', async () => {
      const deps = makeDeps()
      const t = await transformInput(
        { command: 'run_container_step', args: { image: 'node:22', workingDirectory: '/w' }, state: { registryRewrite: { token: 'saved' } } },
        jf,
        deps
      )
      expect(deps.exchange).not.toHaveBeenCalled()
      expect(t.tokenIsNew).toBe(false)
      expect(t.input.args.registry.password).toBe('saved')
    })

    it('does not exchange a token when nothing is rewritten', async () => {
      const deps = makeDeps()
      const c = cfg({
        REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
        REGISTRY_REWRITE_JFROG_OIDC_PROVIDER: 'github',
        REGISTRY_REWRITE_SKIP: 'docker.io'
      })
      await transformInput({ command: 'run_container_step', args: { image: 'node:22', workingDirectory: '/w' } }, c, deps)
      expect(deps.exchange).not.toHaveBeenCalled()
    })
  })

  it('rewrites a Dockerfile into a temp copy, logs in for the build and cleans up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-'))
    const dockerfile = path.join(dir, 'Dockerfile')
    fs.writeFileSync(dockerfile, 'FROM ghcr.io/o/base:1\nRUN true\n')
    const deps = makeDeps()
    const c = cfg({
      REGISTRY_REWRITE_HOST: 'acme.jfrog.io',
      REGISTRY_REWRITE_RULES: '{"ghcr.io":"ghcr"}',
      REGISTRY_REWRITE_JFROG_OIDC_PROVIDER: 'github'
    })
    const t = await transformInput(
      { command: 'run_container_step', args: { dockerfile, workingDirectory: dir } },
      c,
      deps
    )
    const temp = t.input.args.dockerfile
    expect(temp).not.toBe(dockerfile)
    expect(fs.readFileSync(temp, 'utf8')).toBe('FROM acme.jfrog.io/ghcr/o/base:1\nRUN true\n')
    expect(fs.readFileSync(dockerfile, 'utf8')).toBe('FROM ghcr.io/o/base:1\nRUN true\n')
    expect(deps.dockerLogin).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'acme.jfrog.io', password: 'jfrog-token' }))

    for (const cleanup of t.cleanup.reverse()) {
      await cleanup()
    }
    expect(fs.existsSync(temp)).toBe(false)
    expect(deps.dockerLogout).toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('patchResponseState / runOriginalHook', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('merges the token into the response state', () => {
    const file = path.join(tmp, 'response.json')
    fs.writeFileSync(file, JSON.stringify({ state: { network: 'n' }, context: {} }))
    expect(patchResponseState(file, 't')).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).state).toEqual({
      network: 'n',
      registryRewrite: { token: 't' }
    })
  })

  it('reports when there is no response to patch', () => {
    const file = path.join(tmp, 'empty.json')
    fs.writeFileSync(file, '')
    expect(patchResponseState(file, 't')).toBe(false)
    expect(patchResponseState(path.join(tmp, 'missing.json'), 't')).toBe(false)
  })

  it('pipes the payload to the original hook and returns its exit code', async () => {
    const out = path.join(tmp, 'stdin.txt')
    const hook = path.join(tmp, 'fake-hook.js')
    fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0, 'utf8')); process.exit(7)`)
    const code = await runOriginalHook(hook, '{"command":"cleanup_job"}')
    expect(code).toBe(7)
    expect(fs.readFileSync(out, 'utf8')).toBe('{"command":"cleanup_job"}\n')
  })
})

describe('jfrog', () => {
  const jfrog = { url: 'https://acme.jfrog.io', provider: 'github', audience: 'jfrog-github', user: 'github-actions' }
  const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response

  it('exchanges the GitHub OIDC token for an access token', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(json({ value: 'gh-id-token' }))
      .mockResolvedValueOnce(json({ access_token: 'access' }))
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const token = await exchangeOidcToken(
      jfrog,
      { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/?a=b', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req' },
      fetchFn as any
    )
    expect(token).toBe('access')
    expect(fetchFn.mock.calls[0][0]).toBe('https://token.example/?a=b&audience=jfrog-github')
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer req')
    expect(fetchFn.mock.calls[1][0]).toBe('https://acme.jfrog.io/access/api/v1/oidc/token')
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({ subject_token: 'gh-id-token', provider_name: 'github' })
    expect(log).toHaveBeenCalledWith('::add-mask::access')
    log.mockRestore()
  })

  it('explains the missing id-token permission', async () => {
    await expect(exchangeOidcToken(jfrog, {}, jest.fn() as any)).rejects.toThrow(/id-token: write/)
  })

  it('fails when the exchange is rejected', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(json({ value: 'x' })).mockResolvedValueOnce(json({}, 401))
    jest.spyOn(console, 'log').mockImplementation(() => {})
    await expect(
      exchangeOidcToken(jfrog, { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://t', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' }, fetchFn as any)
    ).rejects.toThrow(/HTTP 401/)
  })

  it('revokes a token', async () => {
    const fetchFn = jest.fn().mockResolvedValue(json({}, 200))
    expect(await revokeToken(jfrog, 'tok', fetchFn as any)).toBe(200)
    expect(fetchFn.mock.calls[0][0]).toBe('https://acme.jfrog.io/access/api/v1/tokens/revoke')
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ token: 'tok' })
  })
})
