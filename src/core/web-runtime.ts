import { Readable } from 'node:stream'
import { createMcpHttpServer, installShutdown, tlsFilesFromEnvironment } from './tls-http.js'

export interface WebRuntimeOptions {
  host: string
  port: number
  name: string
  env: NodeJS.ProcessEnv
}

/** Runs a Fetch-compatible handler on the same TLS, streaming, and shutdown infrastructure as native MCP providers. */
export async function serveWebHandler(handler: (request: Request) => Promise<Response>, options: WebRuntimeOptions): Promise<void> {
  const tls = tlsFilesFromEnvironment(options.env)
  const server = createMcpHttpServer((incoming, outgoing) => {
    void (async () => {
      try {
        const host = incoming.headers.host
        if (!host) { outgoing.writeHead(400); outgoing.end('Host is required'); return }
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') headers.set(name, value)
          else if (value) for (const item of value) headers.append(name, item)
        }
        const method = incoming.method ?? 'GET'
        const request = new Request(`${tls ? 'https' : 'http'}://${host}${incoming.url || '/'}`, {
          method, headers,
          ...(incoming.method !== 'GET' && incoming.method !== 'HEAD'
            ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' as const } : {})
        })
        const response = await handler(request)
        const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers)
        const cookies = response.headers.getSetCookie()
        if (cookies.length) responseHeaders['set-cookie'] = cookies
        outgoing.writeHead(response.status, responseHeaders)
        if (!response.body) { outgoing.end(); return }
        const body = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
        body.on('error', () => { console.error(`${options.name} response stream failed`); outgoing.destroy() })
        body.pipe(outgoing)
      } catch (error) {
        console.error(`${options.name} HTTP request failed:`, error instanceof Error ? error.name : 'unknown error')
        if (!outgoing.headersSent) outgoing.writeHead(500)
        outgoing.end('Internal error')
      }
    })()
  }, tls)
  installShutdown(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })
  console.error(`${options.name} listening on ${tls ? 'https' : 'http'}://${options.host}:${options.port}/mcp`)
}
