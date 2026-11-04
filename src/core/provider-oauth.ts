import { createHash, randomBytes } from 'node:crypto'
import type { EncryptedFileStore, StoredGrant, StoredState } from './encrypted-file-store.js'
import { cookieValue, htmlPage } from './http-util.js'
import { boundedJson } from './fetch-json.js'
import { base64Url, timingSafeStringEqual } from './security.js'
import { UPSTREAM_TIMEOUT_MS } from './config-util.js'

const PENDING_TTL_MS = 10 * 60 * 1000
const REFRESH_MARGIN_MS = 60 * 1000
const MAX_PENDING = 1000

export interface PendingProviderGrant {
  subject: string
  verifier: string
  nonce: string
  expiresAt: number
}

export interface BaseProviderOAuthOptions<Extension extends object = object> {
  redirectUrl: URL
  store: EncryptedFileStore<Extension>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export abstract class BaseProviderOAuth<Extension extends object = object> {
  protected abstract readonly id: string
  protected abstract readonly label: string

  readonly #options: BaseProviderOAuthOptions<Extension>
  readonly #pending = new Map<string, PendingProviderGrant>()
  readonly #waiters = new Map<string, Set<(connected: boolean) => void>>()
  readonly #linkBySubject = new Map<string, string>()
  readonly #refreshing = new Map<string, Promise<string | undefined>>()
  #state: Promise<StoredState<Extension>> | undefined
  #mutations: Promise<unknown> = Promise.resolve()

  protected constructor(options: BaseProviderOAuthOptions<Extension>) {
    this.#options = options
  }

  protected get redirectUrl(): URL { return this.#options.redirectUrl }
  protected get fetcher(): typeof globalThis.fetch { return this.#options.fetch ?? globalThis.fetch }
  protected get now(): number { return this.#options.now?.() ?? Date.now() }
  protected loadState(): Promise<StoredState<Extension>> { return (this.#state ??= this.#options.store.load().catch((error: unknown) => { this.#state = undefined; throw error })) }

  protected mutateState<T>(mutate: (state: StoredState<Extension>) => T | Promise<T>): Promise<T> {
    const operation = this.#mutations.then(async () => {
      const current = await this.loadState()
      const state = { ...current, grants: { ...current.grants } } as StoredState<Extension>
      const result = await mutate(state)
      await this.#options.store.save(state)
      this.#state = Promise.resolve(state)
      return result
    })
    this.#mutations = operation.catch(() => undefined)
    return operation
  }

  async waitForGrant(subject: string, timeoutMs: number): Promise<boolean> {
    // Register before checking so a grant stored during the check is not missed.
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(subject) ?? new Set()
      const done = (connected: boolean) => {
        clearTimeout(timer)
        waiters.delete(done)
        if (waiters.size === 0 && this.#waiters.get(subject) === waiters) this.#waiters.delete(subject)
        resolve(connected)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      waiters.add(done)
      this.#waiters.set(subject, waiters)
      this.isConnected(subject).then((connected) => { if (connected) done(true) }, () => done(false))
    })
  }

  async isConnected(subject: string): Promise<boolean> {
    return (await this.loadState()).grants[subject] !== undefined
  }

  async disconnect(subject: string): Promise<boolean> {
    await this.#refreshing.get(subject)?.catch(() => undefined) // a failed refresh must not block removal
    const grant = (await this.loadState()).grants[subject]
    if (!grant) return false
    await this.beforeDisconnect(grant)
    await this.mutateState((state) => { delete state.grants[subject] })
    return true
  }

  async beginConnect(subject: string, reuse = true): Promise<string> {
    if (!subject || subject.length > 512) throw new Error('A verified user subject is required')
    this.#sweep()
    const active = this.#linkBySubject.get(subject)
    if (reuse && active && (this.#pending.get(active)?.expiresAt ?? 0) > this.now) return this.#startUrl(active).toString()
    if (this.#pending.size >= MAX_PENDING) throw new Error(`Too many pending ${this.label} connections; try again shortly`)
    const state = base64Url(randomBytes(32))
    if (reuse) this.#linkBySubject.set(subject, state)
    this.#pending.set(state, {
      subject,
      verifier: base64Url(randomBytes(48)),
      nonce: base64Url(randomBytes(24)),
      expiresAt: this.now + PENDING_TTL_MS
    })
    return this.#startUrl(state).toString()
  }

  async handleStart(url: URL): Promise<Response> {
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    if (!pending || pending.expiresAt <= this.now) return this.page(400, 'Link expired', `Ask your assistant to connect ${this.label} again.`)
    const challenge = base64Url(createHash('sha256').update(pending.verifier).digest())
    const authorize = await this.authorizationUrl(state, pending, challenge)
    const secure = this.redirectUrl.protocol === 'https:' ? '; Secure' : ''
    return new Response(null, { status: 302, headers: {
      location: authorize.toString(),
      'cache-control': 'no-store',
      'set-cookie': `${this.cookieName}=${pending.nonce}; HttpOnly; SameSite=Lax; Path=${this.routePrefix}; Max-Age=600${secure}`
    } })
  }

  async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const state = url.searchParams.get('state') ?? ''
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (pending && this.#linkBySubject.get(pending.subject) === state) this.#linkBySubject.delete(pending.subject)
    if (!pending || pending.expiresAt <= this.now) return this.page(400, 'Link expired', `Ask your assistant to connect ${this.label} again.`)
    const cookie = cookieValue(request, this.cookieName)
    if (!cookie || !timingSafeStringEqual(cookie, pending.nonce)) return this.page(400, 'Wrong browser', `This sign-in was not started in this browser. Ask your assistant to connect ${this.label} and open the link it gives you.`)
    const denied = url.searchParams.get('error')
    if (denied) return this.page(403, 'Not connected', `${this.label} reported: ${denied.replace(/[^\w .-]/g, '')}. Nothing was connected.`)
    const code = url.searchParams.get('code')
    if (!code) return this.page(400, 'Not connected', `${this.label} did not return an authorization code.`)
    try {
      const grant = await this.exchangeCode(code, pending)
      try {
        await this.mutateState((stored) => { stored.grants[pending.subject] = grant })
      } catch (error) {
        await this.afterStoreFailure(grant)
        throw error
      }
      this.#notify(pending.subject)
      return this.page(200, `${this.label} connected`, 'You can close this tab and return to your assistant.')
    } catch (error) {
      console.error(`${this.label} connection failed:`, error instanceof Error ? error.message : 'unknown error')
      return this.page(502, 'Not connected', `${this.label} did not accept the sign-in. Ask your assistant to connect ${this.label} again, or check the MCP server logs.`)
    }
  }

  async accessToken(subject: string): Promise<string | undefined> {
    const grant = (await this.loadState()).grants[subject]
    if (!grant) return undefined
    if (grant.expiresAt - this.now > REFRESH_MARGIN_MS) return grant.accessToken
    const running = this.#refreshing.get(subject)
    if (running) return running
    const refresh = this.#refresh(subject, grant).finally(() => this.#refreshing.delete(subject))
    this.#refreshing.set(subject, refresh)
    return refresh
  }

  protected abstract authorizationUrl(state: string, pending: PendingProviderGrant, challenge: string): Promise<URL> | URL
  protected abstract exchangeCode(code: string, pending: PendingProviderGrant): Promise<StoredGrant>
  protected abstract refreshGrant(grant: StoredGrant, subject: string): Promise<StoredGrant>
  protected async beforeDisconnect(_grant: StoredGrant): Promise<void> {}
  protected async afterStoreFailure(_grant: StoredGrant): Promise<void> {}
  protected async postForm<T>(url: URL, form: Record<string, string>, failureLabel: string, validate: (value: unknown) => value is T, revokeOnRejection = true): Promise<T> {
    const response = await this.fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form)
    })
    const parsed: unknown = await boundedJson(response).catch(() => undefined)
    if (!response.ok) {
      const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
      const message = typeof error?.error_description === 'string' ? error.error_description : typeof error?.error === 'string' ? error.error : `HTTP ${response.status}`
      if (revokeOnRejection && (response.status === 400 || response.status === 401)) throw this.reject(message)
      throw new Error(`${failureLabel} (HTTP ${response.status})`)
    }
    if (!validate(parsed)) throw new Error(`${failureLabel} returned an invalid response`)
    return parsed
  }
  protected page(status: number, title: string, message: string, headers: Record<string, string> = {}): Response {
    return htmlPage(status, title, message, headers)
  }

  protected reject(message: string): OAuthRejected {
    return new OAuthRejected(message)
  }

  get routePrefix(): string { return `/oauth/${this.id}` }
  get cookieName(): string { return `${this.id}_oauth` }

  async #refresh(subject: string, grant: StoredGrant): Promise<string | undefined> {
    try {
      const next = await this.refreshGrant(grant, subject)
      // A newer grant (reconnect during the refresh) must not be overwritten by one derived from the old token.
      return await this.mutateState((state) => {
        const current = state.grants[subject]
        if (current && current.refreshToken !== grant.refreshToken) return current.accessToken
        state.grants[subject] = next
        return next.accessToken
      })
    } catch (error) {
      if (error instanceof OAuthRejected) {
        await this.mutateState((state) => { if (state.grants[subject]?.refreshToken === grant.refreshToken) delete state.grants[subject] })
        return undefined
      }
      throw error
    }
  }

  #startUrl(state: string): URL {
    return new URL(`${this.routePrefix}/start?state=${state}`, this.redirectUrl.origin)
  }

  #notify(subject: string): void {
    for (const done of [...(this.#waiters.get(subject) ?? [])]) done(true)
  }

  #sweep(): void {
    for (const [state, pending] of this.#pending) {
      if (pending.expiresAt <= this.now) {
        this.#pending.delete(state)
        if (this.#linkBySubject.get(pending.subject) === state) this.#linkBySubject.delete(pending.subject)
      }
    }
  }
}

export class OAuthRejected extends Error {}
