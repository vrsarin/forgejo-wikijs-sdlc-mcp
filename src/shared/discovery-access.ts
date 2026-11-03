const DISCOVERY_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list'])
const MAX_DISCOVERY_REQUEST_BYTES = 64 * 1024

/** Discovery credentials must never invoke tools or access user resources. */
export async function discoveryRequestAllowed(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || !request.body) return false
  const reader = request.clone().body?.getReader()
  if (!reader) return false
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_DISCOVERY_REQUEST_BYTES) {
      void reader.cancel()
      return false
    }
    chunks.push(value)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false
    const method = (body as Record<string, unknown>).method
    return typeof method === 'string' && DISCOVERY_METHODS.has(method)
  } catch {
    return false
  }
}
