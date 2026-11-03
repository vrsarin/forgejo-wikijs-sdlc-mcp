import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { EncryptedFileStore, StoredGrant, StoredState } from './store.js'

export const OAUTH_START_PATH = '/oauth/forgejo/start'
export const OAUTH_CALLBACK_PATH = '/oauth/forgejo/callback'
const COOKIE = 'forgejo_oauth'
const PENDING_TTL_MS = 10 * 60 * 1000
const REFRESH_MARGIN_MS = 60 * 1000

export interface ForgejoOAuthOptions {
  /** Forgejo as the browser reaches it (the authorize page). */
  publicUrl: URL
  /** Forgejo as this server reaches it (the token endpoint). */
  internalUrl: URL
  /** Where Forgejo sends the browser back to. */
  redirectUrl: URL
  clientId: string
  clientSecret: string
  store: EncryptedFileStore
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface Pending { sub: string; verifier: string; nonce: string; expiresAt: number }
interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number }

const b64url = (bytes: Buffer) => bytes.toString('base64url')
const sameSecret = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const page = (status: number, title: string, message: string, headers: Record<string, string> = {}) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${message}</p></body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } })
const withBase = (base: URL, path: string) => new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base.origin)

/**
 * OAuth client of Forgejo's own authorization server (authorization code + PKCE). Each user approves once
 * in the browser; this server then holds that user's grant, refreshes it, and calls the Forgejo API with it,
 * so Forgejo applies their permissions and records them as the actor. Nobody pastes a token.
 */
export class ForgejoOAuth {
  readonly #options: ForgejoOAuthOptions
  readonly #pending = new Map<string, Pending>()
  readonly #waiters = new Map<string, Set<(connected: boolean) => void>>()
  readonly #linkBySub = new Map<string, string>() // an unexpired link is reused, so repeated calls do not pile up
  readonly #refreshing = new Map<string, Promise<string | undefined>>()
  #state: Promise<StoredState> | undefined

  constructor(options: ForgejoOAuthOptions) { this.#options = options }

  get #now() { return this.#options.now?.() ?? Date.now() }
  get #fetch() { return this.#options.fetch ?? globalThis.fetch }
  #load(): Promise<StoredState> { return (this.#state ??= this.#options.store.load()) }
  async #save(mutate: (state: StoredState) => void): Promise<void> { const state = await this.#load(); mutate(state); await this.#options.store.save(state) }

  /** Resolves true once `sub` has connected (now, or within `timeoutMs`), false if the wait runs out. */
  async waitForGrant(sub: string, timeoutMs: number): Promise<boolean> {
    if (await this.isConnected(sub)) return true
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(sub) ?? new Set()
      const done = (connected: boolean) => { clearTimeout(timer); waiters.delete(done); resolve(connected) }
      const timer = setTimeout(() => done(false), timeoutMs)
      waiters.add(done)
      this.#waiters.set(sub, waiters)
    })
  }
  #notify(sub: string): void { for (const done of [...(this.#waiters.get(sub) ?? [])]) done(true) }

  async isConnected(sub: string): Promise<boolean> { return (await this.#load()).grants[sub] !== undefined }

  async disconnect(sub: string): Promise<boolean> {
    const had = await this.isConnected(sub)
    if (had) await this.#save((state) => { delete state.grants[sub] })
    return had
  }

  /** Begin a connection for `sub` and return the address the user opens in their browser. */
  async beginConnect(sub: string, reuse = true): Promise<string> {
    this.#sweep()
    const active = this.#linkBySub.get(sub)
    if (reuse && active && (this.#pending.get(active)?.expiresAt ?? 0) > this.#now) return new URL(`${OAUTH_START_PATH}?state=${active}`, this.#options.redirectUrl.origin).toString()
    if (this.#pending.size >= 1000) throw new Error('Too many pending Forgejo connections; try again shortly')
    const state = b64url(randomBytes(32))
    if (reuse) this.#linkBySub.set(sub, state)
    this.#pending.set(state, { sub, verifier: b64url(randomBytes(48)), nonce: b64url(randomBytes(24)), expiresAt: this.#now + PENDING_TTL_MS })
    return new URL(`${OAUTH_START_PATH}?state=${state}`, this.#options.redirectUrl.origin).toString()
  }

  /** Browser route: pin the flow to this browser, then hand over to the Forgejo consent screen. */
  async handleStart(url: URL): Promise<Response> {
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    if (!pending || pending.expiresAt <= this.#now) return page(400, 'Link expired', 'Ask your assistant to connect Forgejo again.')
    const authorize = withBase(this.#options.publicUrl, '/login/oauth/authorize')
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: this.#options.clientId, redirect_uri: this.#options.redirectUrl.toString(), state,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()), code_challenge_method: 'S256'
    }).toString()
    const secure = this.#options.redirectUrl.protocol === 'https:' ? '; Secure' : ''
    return new Response(null, { status: 302, headers: { location: authorize.toString(), 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${pending.nonce}; HttpOnly; SameSite=Lax; Path=/oauth/forgejo; Max-Age=600${secure}` } })
  }

  /** Browser route: Forgejo sends the user back here with a code once they have approved. */
  async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    this.#pending.delete(state) // single use, whatever happens next
    if (pending && this.#linkBySub.get(pending.sub) === state) this.#linkBySub.delete(pending.sub)
    if (!pending || pending.expiresAt <= this.#now) return page(400, 'Link expired', 'Ask your assistant to connect Forgejo again.')
    const cookie = /(?:^|;\s*)forgejo_oauth=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
    if (!cookie || !sameSecret(cookie, pending.nonce)) return page(400, 'Wrong browser', 'This sign-in was not started in this browser. Ask your assistant to connect Forgejo and open the link it gives you.')
    const denied = url.searchParams.get('error')
    if (denied) return page(403, 'Not connected', `Forgejo reported: ${denied.replace(/[^\w .-]/g, '')}. Nothing was connected.`)
    const code = url.searchParams.get('code')
    if (!code) return page(400, 'Not connected', 'Forgejo did not return an authorization code.')
    try {
      const tokens = await this.#token({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: this.#options.redirectUrl.toString() })
      await this.#save((stored) => { stored.grants[pending.sub] = this.#grant(tokens) })
      this.#notify(pending.sub)
    } catch (error) {
      return page(502, 'Not connected', `Forgejo did not accept the sign-in: ${error instanceof Error ? error.message : 'unknown error'}.`)
    }
    return page(200, 'Forgejo connected', 'You can close this tab and return to your assistant.')
  }

  /** The caller's current Forgejo access token, refreshed when close to expiry, or undefined if not connected. */
  async accessToken(sub: string): Promise<string | undefined> {
    const grant = (await this.#load()).grants[sub]
    if (!grant) return undefined
    if (grant.expiresAt - this.#now > REFRESH_MARGIN_MS) return grant.accessToken
    // Refresh tokens may be single use, so refreshes for one user must not overlap.
    const running = this.#refreshing.get(sub)
    if (running) return running
    const refresh = this.#refresh(sub, grant).finally(() => this.#refreshing.delete(sub))
    this.#refreshing.set(sub, refresh)
    return refresh
  }

  async #refresh(sub: string, grant: StoredGrant): Promise<string | undefined> {
    try {
      const tokens = await this.#token({ grant_type: 'refresh_token', refresh_token: grant.refreshToken })
      const next = this.#grant(tokens, grant.refreshToken)
      await this.#save((state) => { state.grants[sub] = next })
      return next.accessToken
    } catch (error) {
      if (error instanceof OAuthRejected) { await this.#save((state) => { delete state.grants[sub] }); return undefined } // revoked or expired: connect again
      throw error
    }
  }

  #grant(tokens: TokenResponse, previousRefresh = ''): StoredGrant {
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previousRefresh, expiresAt: this.#now + (tokens.expires_in ?? 3600) * 1000, scope: '' }
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ ...form, client_id: this.#options.clientId, client_secret: this.#options.clientSecret })
    const response = await this.#fetch(withBase(this.#options.internalUrl, '/login/oauth/access_token'), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body })
    const parsed = await response.json().catch(() => undefined) as (TokenResponse & { error?: string; error_description?: string }) | undefined
    if (!response.ok || !parsed?.access_token) {
      if (response.status === 400 || response.status === 401) throw new OAuthRejected(parsed?.error_description ?? parsed?.error ?? `HTTP ${response.status}`)
      throw new Error(`Forgejo token endpoint failed (HTTP ${response.status})`)
    }
    return parsed
  }

  #sweep(): void { for (const [state, pending] of this.#pending) if (pending.expiresAt <= this.#now) { this.#pending.delete(state); if (this.#linkBySub.get(pending.sub) === state) this.#linkBySub.delete(pending.sub) } }
}

class OAuthRejected extends Error {}
