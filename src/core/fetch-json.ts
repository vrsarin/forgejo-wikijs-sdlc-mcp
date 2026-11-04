import { readBounded } from './read-bounded.js'

export async function boundedJson(response: Response, limit = 256 * 1024): Promise<unknown> {
  let body: Buffer
  try { body = await readBounded(response.body, limit) } catch (error) {
    if (!response.body) throw new Error('Upstream returned an empty response', { cause: error })
    if (error instanceof Error && error.message === 'Message exceeds size limit') throw new Error('Upstream response exceeded the size limit', { cause: error })
    throw error
  }
  try { return JSON.parse(body.toString('utf8')) as unknown } catch {
    throw new Error('Upstream returned invalid JSON')
  }
}
