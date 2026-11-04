export const UPSTREAM_TIMEOUT_MS = 10_000

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

export function isLocalServiceHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || hostname.endsWith('.localhost')
}

export function parseServiceUrl(name: string, value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLocalServiceHostname(url.hostname) || allowInsecureHttp))) {
    throw new Error(`${name} must use HTTPS unless insecure provider HTTP is explicitly enabled`)
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} contains unsupported URL components`)
  return url
}

export function parseRedirectUrl(name: string, value: string | undefined, expectedPath: string): URL {
  const url = new URL(value ?? '')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error(`${name} must be https, or http on localhost/127.0.0.1/[::1]`)
  }
  if (url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must end with ${expectedPath} and carry no query, fragment, or credentials`)
  }
  return url
}

export function parseEncryptionKey(env: NodeJS.ProcessEnv, name: string): Buffer {
  const key = Buffer.from(env[name] ?? '', 'base64')
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded (openssl rand -base64 32)`)
  return key
}
