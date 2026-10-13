import { JfrogConfig } from './config'

type FetchFn = typeof fetch

// Exchanges the job's GitHub OIDC token for a short-lived Artifactory access token
// (same flow as jfrog/setup-jfrog-cli). Requires `permissions: id-token: write`.
export async function exchangeOidcToken(
  jfrog: JfrogConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!requestUrl || !requestToken) {
    throw new Error(
      "JFrog OIDC login needs the job's OIDC token: add 'permissions: id-token: write' to the workflow"
    )
  }

  let url = requestUrl
  if (jfrog.audience) {
    url += `${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(jfrog.audience)}`
  }
  const idResponse = await fetchFn(url, {
    headers: { Authorization: `Bearer ${requestToken}` }
  })
  if (!idResponse.ok) {
    throw new Error(
      `GitHub OIDC token request failed: HTTP ${idResponse.status}`
    )
  }
  const idToken = ((await idResponse.json()) as { value?: string }).value
  if (!idToken) {
    throw new Error('GitHub OIDC token response did not contain a token')
  }
  console.log(`::add-mask::${idToken}`)

  const exchange = await fetchFn(`${jfrog.url}/access/api/v1/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      subject_token: idToken,
      provider_name: jfrog.provider
    })
  })
  if (!exchange.ok) {
    throw new Error(`JFrog OIDC token exchange failed: HTTP ${exchange.status}`)
  }
  const accessToken = ((await exchange.json()) as { access_token?: string })
    .access_token
  if (!accessToken) {
    throw new Error('JFrog OIDC token exchange did not return an access token')
  }
  console.log(`::add-mask::${accessToken}`)
  return accessToken
}

export async function revokeToken(
  jfrog: JfrogConfig,
  token: string,
  fetchFn: FetchFn = fetch
): Promise<number> {
  const response = await fetchFn(`${jfrog.url}/access/api/v1/tokens/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ token })
  })
  return response.status
}
