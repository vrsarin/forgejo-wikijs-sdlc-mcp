import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const pendingLifetime = 10 * 60_000
const refreshMargin = 60_000
const maxResponseBytes = 256 * 1024
const cookieName = 'sdlc_homeassistant_oauth'
const text = (value) => typeof value === 'string' && value.length > 0
const b64url = (size) => randomBytes(size).toString('base64url')
const page = (status, message, headers = {}) => new Response(message, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers }
})

async function boundedJson(response) {
  if (!response.body) throw new Error('Home Assistant returned an empty response')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxResponseBytes) {
      await reader.cancel()
      throw new Error('Home Assistant response exceeded the size limit')
    }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new Error('Home Assistant returned invalid JSON')
  }
}

export class HomeAssistantOAuth {
  #options
  #pending = new Map()
  #links = new Map()
  #state
  #writes = Promise.resolve()
  #refreshing = new Map()

  constructor(options) {
    const publicUrl = new URL(options.publicUrl)
    const internalUrl = new URL(options.internalUrl)
    const callback = new URL(options.callbackUrl)
    if (publicUrl.protocol !== 'https:' || !publicUrl.hostname.endsWith('.localhost') || publicUrl.pathname !== '/' ||
        internalUrl.origin !== 'https://home-assistant-upstream-tls' || internalUrl.pathname !== '/' ||
        callback.origin !== 'http://localhost' || callback.pathname !== '/oauth/homeassistant/callback' ||
        callback.search || callback.hash || callback.username || callback.password ||
        internalUrl.username || internalUrl.password || internalUrl.search || internalUrl.hash) {
      throw new Error('Invalid local Home Assistant OAuth endpoint configuration')
    }
    if (!text(options.issuer) || !options.store) throw new Error('Home Assistant OAuth issuer and store are required')
    this.#options = { ...options, publicUrl, internalUrl, callback }
  }

  #now() { return this.#options.now?.() ?? Date.now() }
  #load() { return (this.#state ??= this.#options.store.load()) }
  #fetch(url, options) { return (this.#options.fetch ?? fetch)(url, options) }

  async #mutate(fn) {
    const operation = this.#writes.then(async () => {
      const current = await this.#load()
      const state = { ...current, grants: { ...current.grants } }
      const result = await fn(state)
      await this.#options.store.save(state)
      this.#state = Promise.resolve(state)
      return result
    })
    // Keep later writes available; the returned operation still reports its failure.
    this.#writes = operation.catch(() => {})
    return operation
  }

  async isConnected(subject) { return Boolean((await this.#load()).grants[subject]) }

  async disconnect(subject) {
    if (this.#refreshing.has(subject)) await this.#refreshing.get(subject)
    return this.#mutate(async (state) => {
      const grant = state.grants[subject]
      if (!grant) return false
      await this.#revoke(grant.refreshToken)
      delete state.grants[subject]
      return true
    })
  }

  beginConnect(subject) {
    if (!text(subject) || subject.length > 512) throw new Error('A verified Keycloak subject is required')
    for (const [state, pending] of this.#pending) {
      if (pending.expiresAt <= this.#now()) {
        this.#pending.delete(state)
        if (this.#links.get(pending.subject) === state) this.#links.delete(pending.subject)
      }
    }
    const current = this.#links.get(subject)
    if (current && this.#pending.has(current)) return new URL(`/oauth/homeassistant/start?state=${current}`, this.#options.callback.origin).toString()
    if (this.#pending.size >= 1000) throw new Error('Too many pending Home Assistant connections')
    const state = b64url(32)
    this.#links.set(subject, state)
    this.#pending.set(state, { subject, verifier: b64url(48), nonce: b64url(24), expiresAt: this.#now() + pendingLifetime })
    return new URL(`/oauth/homeassistant/start?state=${state}`, this.#options.callback.origin).toString()
  }

  handleStart(url) {
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    if (!pending || pending.expiresAt <= this.#now()) return page(400, 'Connection link expired.')
    const authorize = new URL('/auth/authorize', this.#options.publicUrl)
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: 'http://localhost/', redirect_uri: this.#options.callback.toString(), state,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256'
    }).toString()
    return new Response(null, {
      status: 302, headers: {
        location: authorize.toString(), 'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${pending.nonce}; HttpOnly; SameSite=Lax; Path=/oauth/homeassistant; Max-Age=600`
      }
    })
  }

  async #token(body) {
    const response = await this.#fetch(new URL('/auth/token', this.#options.internalUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body)
    })
    if (!response.ok) throw new Error(`Home Assistant token request failed (HTTP ${response.status})`)
    const token = await boundedJson(response)
    if (!text(token.access_token) || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new Error('Home Assistant returned an invalid token response')
    }
    return token
  }

  async #verifyIdentity(subject, token) {
    const response = await this.#fetch(new URL('/api/sdlc-mcp/identity', this.#options.internalUrl), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`Home Assistant identity verification failed (HTTP ${response.status})`)
    const result = await boundedJson(response)
    const expected = createHash('sha256').update(`${this.#options.issuer.replace(/\/$/, '')}.${subject}`).digest('hex')
    if (!Array.isArray(result.oidc_subject_hashes) || !result.oidc_subject_hashes.includes(expected)) {
      throw new Error('Home Assistant account does not match the Keycloak user')
    }
  }

  async #revoke(refreshToken) {
    const response = await this.#fetch(new URL('/auth/revoke', this.#options.internalUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken })
    })
    if (!response.ok) throw new Error(`Home Assistant grant revocation failed (HTTP ${response.status})`)
  }

  async handleCallback(request) {
    const url = new URL(request.url)
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (pending && this.#links.get(pending.subject) === state) this.#links.delete(pending.subject)
    if (!pending || pending.expiresAt <= this.#now()) return page(400, 'Connection link expired.')
    const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    const actual = Buffer.from(cookie ?? '')
    const expected = Buffer.from(pending.nonce)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return page(400, 'Connection must finish in the browser that started it.')
    const code = url.searchParams.get('code')
    if (!code || url.searchParams.has('error')) return page(403, 'Home Assistant authorization was not completed.')
    let tokens
    try {
      tokens = await this.#token({
        grant_type: 'authorization_code', client_id: 'http://localhost/',
        code, code_verifier: pending.verifier, redirect_uri: this.#options.callback.toString()
      })
      if (!text(tokens.refresh_token) || tokens.ha_auth_provider !== 'auth_oidc') throw new Error('Home Assistant did not authorize through Keycloak')
      await this.#verifyIdentity(pending.subject, tokens.access_token)
      await this.#mutate((stored) => {
        stored.grants[pending.subject] = {
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
          expiresAt: this.#now() + tokens.expires_in * 1000, scope: ''
        }
      })
      return page(200, 'Home Assistant connected. You may close this tab.')
    } catch (error) {
      console.error('Home Assistant connection failed:', error instanceof Error ? error.message : 'unknown error')
      if (text(tokens?.refresh_token)) {
        try { await this.#revoke(tokens.refresh_token) } catch (revokeError) {
          console.error('Home Assistant rejected grant could not be revoked:', revokeError instanceof Error ? revokeError.message : 'unknown error')
          return page(502, 'Home Assistant could not be connected; the rejected grant could not be revoked. Contact the administrator.')
        }
      }
      return page(502, 'Home Assistant could not be connected to this Keycloak user.')
    }
  }

  async accessToken(subject) {
    const grant = (await this.#load()).grants[subject]
    if (!grant) return undefined
    if (grant.expiresAt - this.#now() > refreshMargin) return grant.accessToken
    if (this.#refreshing.has(subject)) return this.#refreshing.get(subject)
    const refresh = (async () => {
      const token = await this.#token({ grant_type: 'refresh_token', client_id: 'http://localhost/', refresh_token: grant.refreshToken })
      await this.#verifyIdentity(subject, token.access_token)
      await this.#mutate((stored) => {
        if (stored.grants[subject]?.refreshToken !== grant.refreshToken) throw new Error('Home Assistant grant changed during refresh')
        stored.grants[subject] = {
          ...grant, accessToken: token.access_token, refreshToken: token.refresh_token ?? grant.refreshToken,
          expiresAt: this.#now() + token.expires_in * 1000
        }
      })
      return token.access_token
    })().finally(() => this.#refreshing.delete(subject))
    this.#refreshing.set(subject, refresh)
    return refresh
  }
}
