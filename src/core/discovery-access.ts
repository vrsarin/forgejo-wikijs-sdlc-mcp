import { readBounded } from './read-bounded.js'

export const DISCOVERY_METHODS: ReadonlySet<string> = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list'])
const MAX_DISCOVERY_REQUEST_BYTES = 64 * 1024

/** Discovery credentials must never invoke tools or access user resources. */
export async function discoveryRequestAllowed(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || !request.body) return false
  try {
    const body: unknown = JSON.parse((await readBounded(request.clone().body, MAX_DISCOVERY_REQUEST_BYTES)).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false
    const method = (body as Record<string, unknown>).method
    return typeof method === 'string' && DISCOVERY_METHODS.has(method)
  } catch {
    return false
  }
}
