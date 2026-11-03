import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 1000
const b64url = (bytes: Buffer) => bytes.toString('base64url')

interface PendingLogin {
  nonce: string
  verifier: string
  browserSecret: string
  originalQuery: string
  expiresAt: number
}

export interface LoginFlowOptions {
  issuer: URL
  resource: URL
  clientId: string
  callbackUrl: URL
  routePrefix: string
  cookieName: string
  providerName: string
  provider: {
    accessToken(subject: string): Promise<string | undefined>
    beginConnect(subject: string, reuse: boolean): Promise<string>
  }
  verifyIdentity(token: string): Promise<{ sub?: string; exp?: number; nonce?: unknown }>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function cookieValue(request: Request, name: string): string | undefined {
  const prefix = `${name}=`
  return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
}

function failure(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * Runs a separate Keycloak PKCE login before the original MCP authorization request.
 * The original client request remains untouched and is finally handled by Keycloak.
 */
export class ProviderLoginFlow {
  readonly #options: LoginFlowOptions
  readonly #pending = new Map<string, PendingLogin>()
  readonly #providerPending = new Map<string, PendingLogin>()

  constructor(options: LoginFlowOptions) { this.#options = options }

  get #now(): number { return this.#options.now?.() ?? Date.now() }

  #endpoint(suffix: string): URL {
    return new URL(`${this.#options.issuer.toString().replace(/\/$/, '')}/protocol/openid-connect/${suffix}`)
  }

  #cookie(secret: string, maxAge = 600): string {
    const secure = this.#options.callbackUrl.protocol === 'https:' ? '; Secure' : ''
    return `${this.#options.cookieName}=${secret}; HttpOnly; SameSite=Lax; Path=${this.#options.routePrefix}; Max-Age=${maxAge}${secure}`
  }

  #sweep(): void {
    for (const [state, pending] of this.#pending) if (pending.expiresAt <= this.#now) this.#pending.delete(state)
    for (const [state, pending] of this.#providerPending) if (pending.expiresAt <= this.#now) this.#providerPending.delete(state)
  }

  async start(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const resources = url.searchParams.getAll('resource')
    if (request.method !== 'GET' || resources.length !== 1 || resources[0] !== this.#options.resource.toString() ||
      url.search.length > 8192 || url.searchParams.get('response_type') !== 'code') {
      return failure(400, `Invalid ${this.#options.providerName} MCP authorization request.`)
    }
    if (url.searchParams.getAll('prompt').some((value) => value.split(' ').includes('none'))) {
      const authorize = this.#endpoint('auth-upstream')
      authorize.search = url.search
      return new Response(null, { status: 302, headers: { location: authorize.toString(), 'cache-control': 'no-store' } })
    }
    this.#sweep()
    if (this.#pending.size + this.#providerPending.size >= MAX_PENDING) return failure(503, `Too many pending ${this.#options.providerName} sign-ins. Try again shortly.`)
    const state = b64url(randomBytes(32))
    const pending: PendingLogin = {
      nonce: b64url(randomBytes(32)), verifier: b64url(randomBytes(48)),
      browserSecret: b64url(randomBytes(32)), originalQuery: url.search, expiresAt: this.#now + TTL_MS
    }
    this.#pending.set(state, pending)
    const start = new URL(`${this.#options.routePrefix}/login/start`, this.#options.callbackUrl.origin)
    start.searchParams.set('state', state)
    return new Response(null, { status: 302, headers: { location: start.toString(), 'cache-control': 'no-store' } })
  }

  startBrowser(request: Request): Response {
    const state = new URL(request.url).searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    if (!pending || pending.expiresAt <= this.#now) return failure(400, 'Sign-in expired. Restart the MCP connection.')
    const authorize = this.#endpoint('auth-upstream')
    authorize.search = new URLSearchParams({
      client_id: this.#options.clientId, redirect_uri: this.#options.callbackUrl.toString(),
      response_type: 'code', scope: 'openid', state, nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()), code_challenge_method: 'S256'
    }).toString()
    return new Response(null, { status: 302, headers: { location: authorize.toString(), 'set-cookie': this.#cookie(pending.browserSecret), 'cache-control': 'no-store' } })
  }

  async callback(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (!pending || pending.expiresAt <= this.#now) return failure(400, 'Sign-in expired. Restart the MCP connection.')
    const cookie = cookieValue(request, this.#options.cookieName)
    if (!cookie || !sameSecret(cookie, pending.browserSecret)) return failure(400, 'Sign-in must finish in the browser that started it.')
    const code = url.searchParams.get('code')
    if (!code || url.searchParams.has('error')) return failure(403, 'Keycloak sign-in was not completed. Restart the MCP connection.')
    try {
      const response = await (this.#options.fetch ?? globalThis.fetch)(this.#endpoint('token'), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.#options.clientId, code, code_verifier: pending.verifier, redirect_uri: this.#options.callbackUrl.toString() })
      })
      if (!response.ok) throw new Error(`Keycloak token exchange failed (HTTP ${response.status})`)
      const tokens: unknown = await response.json()
      if (!tokens || typeof tokens !== 'object' || !('id_token' in tokens) || typeof tokens.id_token !== 'string') throw new Error('Keycloak did not return an ID token')
      const subject = await this.#verify(tokens.id_token, pending.nonce)
      if (await this.#options.provider.accessToken(subject)) return this.#resume(pending)
      const link = await this.#options.provider.beginConnect(subject, false)
      const providerState = new URL(link).searchParams.get('state')
      if (!providerState) throw new Error(`${this.#options.providerName} connection did not return state`)
      this.#providerPending.set(providerState, pending)
      return new Response(null, { status: 302, headers: { location: link, 'cache-control': 'no-store' } })
    } catch (error) {
      console.error(`${this.#options.providerName} MCP sign-in failed:`, error instanceof Error ? error.message : 'unknown error')
      return failure(502, 'Unable to complete sign-in. Check the MCP server logs and restart the connection.')
    }
  }

  async #verify(token: string, nonce: string): Promise<string> {
    const payload = await this.#options.verifyIdentity(token)
    if (!payload.sub || !payload.exp || payload.nonce !== nonce) throw new Error('Invalid Keycloak ID token')
    return payload.sub
  }

  /** Resume only the browser and authorization request that initiated this provider grant. */
  finishProvider(request: Request, response: Response): Response {
    const state = new URL(request.url).searchParams.get('state') ?? ''
    const pending = this.#providerPending.get(state)
    if (!pending) return response
    this.#providerPending.delete(state)
    const cookie = cookieValue(request, this.#options.cookieName)
    if (response.status !== 200 || pending.expiresAt <= this.#now || !cookie || !sameSecret(cookie, pending.browserSecret)) return response
    return this.#resume(pending)
  }

  #resume(pending: PendingLogin): Response {
    const authorize = this.#endpoint('auth-upstream')
    authorize.search = pending.originalQuery
    return new Response(null, { status: 302, headers: { location: authorize.toString(), 'set-cookie': this.#cookie('', 0), 'cache-control': 'no-store' } })
  }
}
