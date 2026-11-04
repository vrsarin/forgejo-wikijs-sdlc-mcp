import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createPrivateKey, X509Certificate } from 'node:crypto'

export interface TlsFiles {
  certificate: string
  key: string
  mode: 'static' | 'letsencrypt'
}

export function tlsFilesFromEnvironment(env: NodeJS.ProcessEnv): TlsFiles | undefined {
  const enabled = env.ENABLE_TLS
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new Error('ENABLE_TLS must be true or false')
  }
  const legacyCertificate = env.MCP_TLS_CERT_PATH
  const legacyKey = env.MCP_TLS_KEY_PATH
  if (enabled === undefined) {
    if (legacyCertificate === undefined && legacyKey === undefined) return undefined
    if (!legacyCertificate || !legacyKey) throw new Error('Both MCP_TLS_CERT_PATH and MCP_TLS_KEY_PATH are required')
    return { certificate: legacyCertificate, key: legacyKey, mode: 'static' }
  }
  if (enabled === 'false') {
    if (env.TLS_MODE || env.TLS_CERT_PATH || env.TLS_KEY_PATH || legacyCertificate || legacyKey) {
      throw new Error('TLS settings must be removed when ENABLE_TLS=false')
    }
    return undefined
  }

  const mode = env.TLS_MODE
  if (mode !== 'static' && mode !== 'letsencrypt') {
    throw new Error('TLS_MODE must be static or letsencrypt when ENABLE_TLS=true')
  }
  if (mode === 'static') {
    const certificate = env.TLS_CERT_PATH ?? legacyCertificate
    const key = env.TLS_KEY_PATH ?? legacyKey
    if (!certificate || !key) throw new Error('TLS_CERT_PATH and TLS_KEY_PATH are required for static TLS')
    return { certificate, key, mode }
  }

  const domain = env.TLS_DOMAIN?.trim()
  const email = env.TLS_EMAIL?.trim()
  if (!domain || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain)) {
    throw new Error('TLS_DOMAIN must be a valid public DNS hostname for Let\'s Encrypt')
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('TLS_EMAIL is required for Let\'s Encrypt')
  }
  const configDir = env.TLS_ACME_CONFIG_DIR ?? '/data/letsencrypt'
  return {
    certificate: env.TLS_CERT_PATH || `${configDir}/live/${domain}/fullchain.pem`,
    key: env.TLS_KEY_PATH || `${configDir}/live/${domain}/privkey.pem`,
    mode
  }
}

export function createMcpHttpServer(listener: RequestListener, tls: TlsFiles | undefined): Server {
  if (!tls) return createHttpServer(listener)
  const credentials = () => {
    const cert = readFileSync(tls.certificate)
    const key = readFileSync(tls.key)
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) {
      throw new Error('TLS certificate and private key do not match')
    }
    return { cert, key }
  }
  const server = createHttpsServer(credentials(), listener)
  const reload = () => {
    try {
      const next = credentials()
      server.setSecureContext(next)
    } catch (error) {
      console.error('MCP TLS certificate reload failed:', error instanceof Error ? error.message : 'unknown error')
    }
  }
  watchFile(tls.certificate, { interval: 1000, persistent: false }, reload)
  watchFile(tls.key, { interval: 1000, persistent: false }, reload)
  server.once('close', () => {
    unwatchFile(tls.certificate, reload)
    unwatchFile(tls.key, reload)
  })
  return server
}

/** Installs idempotent signal handling and removes process listeners after the server closes. */
export function installShutdown(server: Server, onClose?: () => void | Promise<void>, exit: typeof process.exit = process.exit): void {
  let closing = false
  let forceTimer: NodeJS.Timeout | undefined
  const shutdown = () => {
    if (closing) return
    closing = true
    forceTimer = setTimeout(() => {
      console.error('MCP shutdown timed out; forcing process exit')
      exit(1)
    }, 10_000)
    forceTimer.unref()
    void Promise.resolve(onClose?.())
      .catch((error: unknown) => console.error('MCP shutdown cleanup failed:', error instanceof Error ? error.message : 'unknown error'))
      .finally(() => {
        server.close()
        server.closeIdleConnections()
      })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.once('close', () => {
    if (forceTimer) clearTimeout(forceTimer)
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
  })
}
