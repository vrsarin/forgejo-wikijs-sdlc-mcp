import { AsyncLocalStorage } from 'node:async_hooks'

/** Forgejo provider implementation used by the shared MCP runtime. */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
const ALLOWED_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/markdown', 'application/json', 'application/pdf', 'application/zip'])

export type ForgejoRecord = Record<string, unknown>
export interface ForgejoIssue extends ForgejoRecord { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; html_url: string; updated_at: string }
export interface ForgejoPullRequest extends ForgejoRecord { id: number; number: number; title: string; body: string; state: string; html_url: string; head: { ref: string }; base: { ref: string } }
export const FORGEJO_TOKEN_HEADER = 'x-forgejo-token'
export interface ForgejoClientOptions { baseUrl: URL; token?: string | undefined; allowedRepositories: ReadonlySet<string>; requestTimeoutMs?: number; fetch?: typeof globalThis.fetch }
export class ForgejoApiError extends Error {
  constructor(message: string, readonly status: number, readonly method: string, readonly path: string) { super(message); this.name = 'ForgejoApiError' }
}

export class ForgejoClient {
  readonly #options: ForgejoClientOptions
  readonly #callerToken = new AsyncLocalStorage<string>()
  constructor(options: ForgejoClientOptions) { this.#options = options }

  /** Run `fn` so every Forgejo request inside it authenticates as the caller who owns `token`. */
  runAs<T>(token: string, fn: () => Promise<T>): Promise<T> { return this.#callerToken.run(token, fn) }

  getIssue(owner: string, repo: string, index: number): Promise<ForgejoIssue> { return this.#repo(owner, repo, 'GET', `/issues/${index}`) }
  searchIssues(owner: string, repo: string, input: ForgejoRecord = {}): Promise<ForgejoIssue[]> { return this.#repo(owner, repo, 'GET', `/issues${query(input)}`) }
  async createIssue(owner: string, repo: string, input: ForgejoRecord & { title: string; body?: string; idempotencyKey?: string }): Promise<{ created: boolean; issue: ForgejoIssue }> {
    const { idempotencyKey, ...payload } = input
    const marker = idempotencyKey ? markerFor(idempotencyKey) : undefined
    if (marker) {
      const existing = await this.#findIssueByMarker(owner, repo, input.title, marker)
      if (existing) return { created: false, issue: existing }
      payload.body = `${input.body ?? ''}\n\n${marker}`.trim()
    }
    const created = await this.#repo<ForgejoIssue>(owner, repo, 'POST', '/issues', payload)
    return { created: true, issue: await this.getIssue(owner, repo, created.number) }
  }
  /**
   * Looks the marker up in the newest issues by plain listing, not text search: Forgejo's search index
   * can lag a new issue, which let a retry create a duplicate. Bounded to the newest 200 issues.
   */
  async #findIssueByMarker(owner: string, repo: string, title: string, marker: string): Promise<ForgejoIssue | undefined> {
    for (let page = 1; page <= 4; page++) {
      const issues = await this.searchIssues(owner, repo, { state: 'all', type: 'issues', limit: 50, page })
      const found = issues.find((item) => item.title === title && item.body?.includes(marker))
      if (found || issues.length < 50) return found
    }
    return undefined
  }
  async updateIssue(owner: string, repo: string, index: number, input: ForgejoRecord): Promise<ForgejoIssue> { await this.#repo(owner, repo, 'PATCH', `/issues/${index}`, input); return this.getIssue(owner, repo, index) }
  listIssueComments(owner: string, repo: string, index: number, page = 1, limit = 50): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/issues/${index}/comments${query({ page, limit })}`) }
  async addIssueComment(owner: string, repo: string, index: number, body: string, idempotencyKey?: string): Promise<{ created: boolean; comment: ForgejoRecord }> {
    const marker = idempotencyKey ? markerFor(idempotencyKey) : undefined
    if (marker) {
      const existing = (await this.listIssueComments(owner, repo, index, 1, 100)).find((item) => typeof item.body === 'string' && item.body.includes(marker))
      if (existing) return { created: false, comment: existing }
      body = `${body}\n\n${marker}`
    }
    const comment = await this.#repo<ForgejoRecord>(owner, repo, 'POST', `/issues/${index}/comments`, { body })
    return { created: true, comment: await this.#repo(owner, repo, 'GET', `/issues/comments/${numberField(comment, 'id')}`) }
  }
  listDependencies(owner: string, repo: string, index: number): Promise<ForgejoIssue[]> { return this.#repo(owner, repo, 'GET', `/issues/${index}/dependencies`) }
  async addDependency(owner: string, repo: string, index: number, dependency: { owner: string; repo: string; index: number }): Promise<ForgejoIssue[]> { this.#assertAllowed(dependency.owner, dependency.repo); await this.#repo(owner, repo, 'POST', `/issues/${index}/dependencies`, dependency); return this.listDependencies(owner, repo, index) }
  async removeDependency(owner: string, repo: string, index: number, dependency: { owner: string; repo: string; index: number }): Promise<ForgejoIssue[]> { this.#assertAllowed(dependency.owner, dependency.repo); await this.#repo(owner, repo, 'DELETE', `/issues/${index}/dependencies`, dependency); return this.listDependencies(owner, repo, index) }
  listLabels(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/labels?limit=100') }
  listMilestones(owner: string, repo: string, state = 'all'): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/milestones${query({ state, limit: 100 })}`) }
  listCollaborators(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/collaborators?limit=100') }
  async setIssueLabels(owner: string, repo: string, index: number, labels: number[]): Promise<ForgejoIssue> { await this.#repo(owner, repo, 'PUT', `/issues/${index}/labels`, { labels }); return this.getIssue(owner, repo, index) }
  listTrackedTime(owner: string, repo: string, index: number): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/issues/${index}/times`) }
  async addTrackedTime(owner: string, repo: string, index: number, seconds: number, userName?: string): Promise<ForgejoRecord[]> { await this.#repo(owner, repo, 'POST', `/issues/${index}/times`, { time: seconds, ...(userName ? { user_name: userName } : {}) }); return this.listTrackedTime(owner, repo, index) }

  getPullRequest(owner: string, repo: string, index: number): Promise<ForgejoPullRequest> { return this.#repo(owner, repo, 'GET', `/pulls/${index}`) }
  listPullRequests(owner: string, repo: string, state = 'open', page = 1, limit = 50): Promise<ForgejoPullRequest[]> { return this.#repo(owner, repo, 'GET', `/pulls${query({ state, page, limit })}`) }
  async createPullRequest(owner: string, repo: string, input: { title: string; body?: string; head: string; base: string; draft?: boolean; idempotencyKey?: string }): Promise<{ created: boolean; pullRequest: ForgejoPullRequest }> {
    const { idempotencyKey, ...payload } = input
    const marker = idempotencyKey ? markerFor(idempotencyKey) : undefined
    if (marker) {
      const existing = (await this.listPullRequests(owner, repo, 'all', 1, 100)).find((item) => item.head.ref === input.head && item.base.ref === input.base && item.body?.includes(marker))
      if (existing) return { created: false, pullRequest: existing }
      payload.body = `${input.body ?? ''}\n\n${marker}`.trim()
    }
    const created = await this.#repo<ForgejoPullRequest>(owner, repo, 'POST', '/pulls', payload)
    return { created: true, pullRequest: await this.getPullRequest(owner, repo, created.number) }
  }
  async updatePullRequest(owner: string, repo: string, index: number, input: ForgejoRecord): Promise<ForgejoPullRequest> { await this.#repo(owner, repo, 'PATCH', `/pulls/${index}`, input); return this.getPullRequest(owner, repo, index) }
  listPullFiles(owner: string, repo: string, index: number): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/pulls/${index}/files`) }
  listPullCommits(owner: string, repo: string, index: number): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/pulls/${index}/commits`) }
  listPullReviews(owner: string, repo: string, index: number): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/pulls/${index}/reviews`) }
  async createPullReview(owner: string, repo: string, index: number, input: ForgejoRecord): Promise<ForgejoRecord> { const review = await this.#repo<ForgejoRecord>(owner, repo, 'POST', `/pulls/${index}/reviews`, input); return this.#repo(owner, repo, 'GET', `/pulls/${index}/reviews/${numberField(review, 'id')}`) }
  async requestReviewers(owner: string, repo: string, index: number, reviewers: string[], teams: string[]): Promise<ForgejoPullRequest> { await this.#repo(owner, repo, 'POST', `/pulls/${index}/requested_reviewers`, { reviewers, team_reviewers: teams }); return this.getPullRequest(owner, repo, index) }

  getRepository(owner: string, repo: string): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', '') }
  listCommits(owner: string, repo: string, sha?: string, page = 1, limit = 50): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/commits${query({ sha, page, limit })}`) }
  getCommit(owner: string, repo: string, sha: string): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/git/commits/${segment(sha)}`) }
  getCombinedStatus(owner: string, repo: string, ref: string): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/commits/${segment(ref)}/status`) }
  listStatuses(owner: string, repo: string, ref: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/commits/${segment(ref)}/statuses`) }
  listActionRuns(owner: string, repo: string, page = 1, limit = 30): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/actions/runs${query({ page, limit })}`) }
  getActionRun(owner: string, repo: string, runId: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/actions/runs/${runId}`) }
  listActionJobs(owner: string, repo: string, runId: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/actions/runs/${runId}/jobs`) }
  getActionJob(owner: string, repo: string, jobId: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/actions/jobs/${jobId}`) }
  getActionJobLog(owner: string, repo: string, jobId: number): Promise<string> { return this.#repoText(owner, repo, `/actions/jobs/${jobId}/logs`) }
  listActionArtifacts(owner: string, repo: string, runId?: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', runId ? `/actions/runs/${runId}/artifacts` : '/actions/artifacts') }
  getActionArtifact(owner: string, repo: string, artifactId: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/actions/artifacts/${artifactId}`) }

  listNotifications(owner?: string, repo?: string, all = false): Promise<ForgejoRecord[]> { return owner && repo ? this.#repo(owner, repo, 'GET', `/notifications${query({ all })}`) : this.#request('GET', `/notifications${query({ all })}`) }
  getNotification(id: number): Promise<ForgejoRecord> { return this.#request('GET', `/notifications/threads/${id}`) }
  async markNotificationRead(id: number): Promise<ForgejoRecord> { await this.#request('PATCH', `/notifications/threads/${id}`, { to_status: 'read' }); return this.getNotification(id) }
  listOrganizations(): Promise<ForgejoRecord[]> { return this.#request('GET', '/user/orgs') }
  listOrganizationTeams(org: string): Promise<ForgejoRecord[]> { return this.#request('GET', `/orgs/${segment(org)}/teams`) }
  listRepositoryTeams(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/teams') }
  listTeamMembers(teamId: number): Promise<ForgejoRecord[]> { return this.#request('GET', `/teams/${teamId}/members`) }
  listReleases(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/releases') }
  listTags(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/tags') }
  listBranchProtections(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/branch_protections') }
  getBranchProtection(owner: string, repo: string, name: string): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/branch_protections/${segment(name)}`) }
  listWebhooks(owner: string, repo: string): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', '/hooks') }
  getWebhook(owner: string, repo: string, id: number): Promise<ForgejoRecord> { return this.#repo(owner, repo, 'GET', `/hooks/${id}`) }
  async testWebhook(owner: string, repo: string, id: number): Promise<ForgejoRecord> { await this.#repo(owner, repo, 'POST', `/hooks/${id}/tests`); return this.getWebhook(owner, repo, id) }
  listAttachments(owner: string, repo: string, index: number): Promise<ForgejoRecord[]> { return this.#repo(owner, repo, 'GET', `/issues/${index}/assets`) }
  async uploadAttachment(owner: string, repo: string, index: number, filename: string, mediaType: string, base64: string): Promise<ForgejoRecord[]> {
    this.#assertAllowed(owner, repo)
    if (!ALLOWED_ATTACHMENT_TYPES.has(mediaType)) throw new Error(`Attachment media type ${mediaType} is not allowed`)
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment must be between 1 byte and 2 MiB')
    if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/.test(filename)) throw new Error('Attachment filename is invalid')
    const form = new FormData(); form.append('attachment', new Blob([bytes], { type: mediaType }), filename)
    await this.#request('POST', `/repos/${segment(owner)}/${segment(repo)}/issues/${index}/assets`, form)
    return this.listAttachments(owner, repo, index)
  }

  #assertAllowed(owner: string, repo: string): void { const repository = `${owner}/${repo}`; if (!this.#options.allowedRepositories.has(repository)) throw new Error(`Repository ${repository} is not in SDLC_ALLOWED_REPOSITORIES`) }
  #repo<T>(owner: string, repo: string, method: string, suffix: string, body?: unknown): Promise<T> { this.#assertAllowed(owner, repo); return this.#request(method, `/repos/${segment(owner)}/${segment(repo)}${suffix}`, body) }
  #repoText(owner: string, repo: string, suffix: string): Promise<string> { this.#assertAllowed(owner, repo); return this.#requestText('GET', `/repos/${segment(owner)}/${segment(repo)}${suffix}`) }
  async #request<T>(method: string, path: string, body?: unknown): Promise<T> { const { response, text } = await this.#raw(method, path, body); if (!text) return undefined as T; try { return JSON.parse(text) as T } catch { throw new ForgejoApiError('Forgejo returned invalid JSON', response.status, method, path) } }
  async #requestText(method: string, path: string): Promise<string> { return (await this.#raw(method, path)).text }
  async #raw(method: string, path: string, body?: unknown): Promise<{ response: Response; text: string }> {
    const basePath = this.#options.baseUrl.pathname.replace(/\/+$/, '')
    const url = new URL(`${basePath}/api/v1${path}`, this.#options.baseUrl.origin)
    const token = this.#callerToken.getStore() ?? this.#options.token
    if (!token) throw new Error('No Forgejo credential for this request; connect Forgejo with connect_forgejo, or send a token in the X-Forgejo-Token header.')
    const isForm = body instanceof FormData
    // Provider API calls remain configurable because large Forgejo instances may need a deployment-specific deadline.
    const response = await (this.#options.fetch ?? globalThis.fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(this.#options.requestTimeoutMs ?? 10_000), headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined || isForm ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }) })
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_RESPONSE_BYTES) throw new ForgejoApiError('Forgejo response exceeded the configured limit', response.status, method, path)
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ForgejoApiError('Forgejo response exceeded the configured limit', response.status, method, path)
    if (!response.ok) throw new ForgejoApiError(`Forgejo request failed with HTTP ${response.status}`, response.status, method, path)
    return { response, text }
  }
}

function segment(value: string): string { if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid Forgejo path segment: ${value}`); return encodeURIComponent(value) }
function query(values: ForgejoRecord): string { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value)); const encoded = params.toString(); return encoded ? `?${encoded}` : '' }
function markerFor(key: string): string { if (!/^[A-Za-z0-9_.:-]{3,128}$/.test(key)) throw new Error('Idempotency key is invalid'); return `<!-- sdlc-idempotency:${key} -->` }
function numberField(value: ForgejoRecord, key: string): number { const field = value[key]; if (typeof field !== 'number') throw new Error(`Forgejo response omitted numeric ${key}`); return field }
