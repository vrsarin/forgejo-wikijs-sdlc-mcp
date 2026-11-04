import { readBounded } from '../../core/read-bounded.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TOOL_PAGES = 100
const PROTOCOL_VERSION = '2025-06-18'

/** Wiki.js provider implementation used by the shared MCP runtime. */

export const WIKIJS_TOKEN_HEADER = 'x-wikijs-token'

export interface WikiJsTool { name: string; title?: string; description?: string; annotations?: Record<string, unknown> }
export interface WikiJsDiscovery { server: { name?: string; version?: string }; protocolVersion?: string; tools: WikiJsTool[] }
export interface WikiJsClientOptions { mcpUrl: URL; requestTimeoutMs?: number; fetch?: typeof globalThis.fetch }

export class WikiJsError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'WikiJsError' }
}

/**
 * Client for the official Wiki.js MCP endpoint. Every call carries the calling user's own personal
 * access token, so Wiki.js applies that user's groups and page rules and attributes the action to them.
 * The token is never stored, cached, or logged here.
 */
export class WikiJsClient {
  readonly #options: WikiJsClientOptions
  constructor(options: WikiJsClientOptions) { this.#options = options }

  async discover(token: string): Promise<WikiJsDiscovery> {
    const initialized = await this.#rpc<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }>(token, 1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'wikijs_sdlc', version: '0.1.0' } })
    await this.#notifyInitialized(token, initialized.sessionId)
    const tools: WikiJsTool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let sessionId = initialized.sessionId
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listed = await this.#rpc<{ tools?: WikiJsTool[]; nextCursor?: string }>(token, page + 2, 'tools/list', cursor ? { cursor } : {}, sessionId)
      sessionId = listed.sessionId
      tools.push(...(listed.result.tools ?? []))
      const next = listed.result.nextCursor
      if (next === undefined) break
      if (typeof next !== 'string' || next.length === 0) throw new WikiJsError('Wiki.js returned an invalid tools cursor', 502)
      if (cursors.has(next)) throw new WikiJsError('Wiki.js returned a repeated tools cursor', 502)
      cursors.add(next)
      cursor = next
      if (page === MAX_TOOL_PAGES - 1) throw new WikiJsError('Wiki.js returned too many tool pages', 502)
    }
    return {
      server: { ...initialized.result.serverInfo },
      ...(initialized.result.protocolVersion ? { protocolVersion: initialized.result.protocolVersion } : {}),
      tools: tools.map(({ name, title, description, annotations }) => ({ name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(annotations ? { annotations } : {}) }))
    }
  }

  #headers(token: string, sessionId?: string): Record<string, string> {
    return { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION, authorization: `Bearer ${token}`, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }
  }

  async #notifyInitialized(token: string, sessionId?: string): Promise<void> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(this.#options.mcpUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#options.requestTimeoutMs ?? 10_000),
      headers: this.#headers(token, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    })
    if (!response.ok) throw new WikiJsError(`Wiki.js MCP refused notifications/initialized (HTTP ${response.status})`, response.status)
    if (response.body) await readBounded(response.body, MAX_RESPONSE_BYTES)
  }

  async #rpc<T>(token: string, id: number, method: string, params: unknown, sessionId?: string): Promise<{ result: T; sessionId?: string }> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(this.#options.mcpUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#options.requestTimeoutMs ?? 10_000),
      headers: this.#headers(token, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    let text: string
    try { text = (await readBounded(response.body, MAX_RESPONSE_BYTES)).toString('utf8') } catch {
      throw new WikiJsError('Wiki.js response exceeded the configured limit', response.status)
    }
    let body: { result?: T; error?: { message?: string } } | undefined
    try { body = text ? this.#decodeResponse(text, response.headers.get('content-type')) : undefined } catch { throw new WikiJsError('Wiki.js returned an invalid Streamable HTTP response', response.status) }
    if (!response.ok || body?.error || body?.result === undefined) {
      // Wiki.js explains its refusals (disabled, missing scope, missing use:mcp); none of that echoes the token.
      throw new WikiJsError(`Wiki.js MCP refused ${method} (HTTP ${response.status}): ${body?.error?.message ?? 'no result'}`, response.status)
    }
    const nextSession = response.headers.get('mcp-session-id') ?? sessionId
    return { result: body.result, ...(nextSession ? { sessionId: nextSession } : {}) }
  }

  #decodeResponse<T>(text: string, contentType: string | null): { result?: T; error?: { message?: string } } {
    if (!contentType?.toLowerCase().includes('text/event-stream')) return JSON.parse(text) as { result?: T; error?: { message?: string } }
    for (const event of text.replaceAll('\r\n', '\n').split('\n\n')) {
      const data = event.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') return JSON.parse(data) as { result?: T; error?: { message?: string } }
    }
    throw new Error('SSE response did not contain a JSON-RPC message')
  }
}
