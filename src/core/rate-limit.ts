interface Bucket {
  count: number
  resetAt: number
}

export class FixedWindowRateLimiter {
  readonly #buckets = new Map<string, Bucket>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) { this.#now = now }

  consume(key: string, limit: number, windowMs = 60_000): { allowed: boolean; retryAfter: number } {
    const now = this.#now()
    let bucket = this.#buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      this.#buckets.set(key, bucket)
    }
    bucket.count += 1
    if (this.#buckets.size > 10_000) this.#sweep(now)
    return { allowed: bucket.count <= limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key)
    }
    while (this.#buckets.size > 10_000) this.#buckets.delete(this.#buckets.keys().next().value as string)
  }
}

export function rateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) }
  })
}

export function enforceRateLimit(
  limiter: FixedWindowRateLimiter,
  identity: string,
  sessionId: string | null,
  category: 'discovery' | 'tool' | 'other'
): Response | undefined {
  const limit = category === 'tool' ? 10 : category === 'discovery' ? 30 : 100
  const identityResult = limiter.consume(`identity:${identity}:${category}`, limit)
  if (!identityResult.allowed) return rateLimitResponse(identityResult.retryAfter)
  if (sessionId && sessionId.length <= 128) {
    const sessionResult = limiter.consume(`session:${identity}:${sessionId}:${category}`, limit * 2)
    if (!sessionResult.allowed) return rateLimitResponse(sessionResult.retryAfter)
  }
  return undefined
}
