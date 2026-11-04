import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceRateLimit, FixedWindowRateLimiter } from '../../src/core/rate-limit.js'

test('rate limits by identity and returns a retry interval', async () => {
  let now = 1_000
  const limiter = new FixedWindowRateLimiter(() => now)
  for (let count = 0; count < 10; count++) assert.equal(enforceRateLimit(limiter, 'alice', null, 'tool'), undefined)
  const response = enforceRateLimit(limiter, 'alice', null, 'tool')
  assert.equal(response?.status, 429)
  assert.equal(response?.headers.get('retry-after'), '60')
  now += 60_000
  assert.equal(enforceRateLimit(limiter, 'alice', null, 'tool'), undefined)
})

test('uses a separate bucket for each authenticated identity', () => {
  const limiter = new FixedWindowRateLimiter(() => 1_000)
  for (let count = 0; count < 10; count++) enforceRateLimit(limiter, 'alice', null, 'tool')
  assert.equal(enforceRateLimit(limiter, 'bob', null, 'tool'), undefined)
})
