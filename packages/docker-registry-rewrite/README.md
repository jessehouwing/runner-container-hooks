# docker-registry-rewrite-hook

A wrapper around the **unmodified** `packages/docker` container hook. It rewrites image
references to a configurable registry host (for example a JFrog Artifactory remote repository)
and can authenticate to that host with a short-lived token obtained through GitHub OIDC.
Then it runs the original hook, passing stdout, stderr and the exit code through.

Without `REGISTRY_REWRITE_HOST` (or `REGISTRY_REWRITE_JFROG_URL`) it is a transparent pass-through.

## Setup

```sh
npm run build-all                                   # builds hooklib + docker (dist/index.js)
npm ci --prefix packages/docker-registry-rewrite
npm run build --prefix packages/docker-registry-rewrite
```

Point the runner at the wrapper, together with the settings below:

```sh
ACTIONS_RUNNER_CONTAINER_HOOKS=/path/to/packages/docker-registry-rewrite/lib/index.js
```

The wrapper runs the original hook from `../docker/dist/index.js` by default.
Override with `REGISTRY_REWRITE_ORIGINAL_HOOK`.

## What gets rewritten

- `prepare_job`: the job container and all service container images.
- `run_container_step`: the step image (`docker://` actions and container actions) and the
  `FROM` lines of a Dockerfile action. The Dockerfile is rewritten to a temporary copy next to
  the original, which is deleted afterwards. Stage references, `scratch` and `$ARG` images are untouched.
  `COPY --from=<image>` is not rewritten.

Example: with host `acme.jfrog.io` and rules `{"docker.io":"hub","ghcr.io":"ghcr"}`

| Original | Rewritten |
| --- | --- |
| `node:22` | `acme.jfrog.io/hub/node:22` |
| `ghcr.io/org/img@sha256:...` | `acme.jfrog.io/ghcr/org/img@sha256:...` |
| `mcr.microsoft.com/dotnet/sdk:9` | unchanged (no rule) |

## Configuration (environment of the runner process)

| Variable | Meaning |
| --- | --- |
| `REGISTRY_REWRITE_HOST` | Target registry host. Required unless `..._JFROG_URL` is set (host derived from it). |
| `REGISTRY_REWRITE_RULES` | JSON map of source registry to path prefix on the target, e.g. `{"docker.io":"hub","*":"proxy"}`. `*` is the fallback. When set, registries without a rule are left alone. When unset, every registry host is replaced and the image path is kept. |
| `REGISTRY_REWRITE_SKIP` | Comma-separated registries that are never rewritten. Images already on the target host are never rewritten. |
| `REGISTRY_REWRITE_FORWARD_CREDENTIALS` | `true` sends the workflow's `credentials:` for the original registry to the target host. Default: they are **dropped** so they never go to a different host. |
| `REGISTRY_REWRITE_ORIGINAL_HOOK` | Path to the original hook (default `../docker/dist/index.js`). |

### JFrog Artifactory via GitHub OIDC

| Variable | Meaning |
| --- | --- |
| `REGISTRY_REWRITE_JFROG_OIDC_PROVIDER` | Name of the OIDC integration in JFrog. Setting it enables the login. |
| `REGISTRY_REWRITE_JFROG_URL` | Platform URL (default `https://<REGISTRY_REWRITE_HOST>`). |
| `REGISTRY_REWRITE_JFROG_OIDC_AUDIENCE` | Optional audience for the GitHub OIDC token. |
| `REGISTRY_REWRITE_JFROG_USER` | Docker login user name (default `github-actions`; Artifactory accepts any name for tokens). |

The workflow needs `permissions: id-token: write`. The wrapper:

1. requests the job's OIDC token and exchanges it at `POST <url>/access/api/v1/oidc/token`;
2. injects the access token as the `registry` credentials of every rewritten image, so the original
   hook's own `docker login` / `pull` just works (a temporary docker login is used for Dockerfile builds);
3. keeps the token in the hook state (returned from `prepare_job`) so later steps reuse it, masks it
   with `::add-mask::`, and revokes it in `cleanup_job` (`POST <url>/access/api/v1/tokens/revoke`).
   Tokens created outside `prepare_job` are revoked as soon as that step finishes.

Because the token lives in the hook state, it stays in runner memory for the job's duration.

## Requirements and caveats

- Container hooks only run if the runner has `ACTIONS_RUNNER_CONTAINER_HOOKS` set and the service
  enables `DistributedTask.AllowRunnerContainerHooks` (observed as `true` on GitHub-hosted runners).
- The hook runs with the runner's Node, so Node 18+ (global `fetch`) is required.
- With hooks enabled the runner does no docker handling itself; the original docker hook does.
- Docker Hub official images (`node:22`) are rewritten to `<host>/<prefix>/node:22` without `library/`.
  Artifactory remote repositories resolve this; other registries may need a rule or `library/` path.

## Tests

```sh
npm test --prefix packages/docker-registry-rewrite
```
