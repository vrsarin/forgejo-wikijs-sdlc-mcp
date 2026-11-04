import { timingSafeEqual } from 'node:crypto'

export function timingSafeStringEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left)
  const expected = Buffer.from(right)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}
