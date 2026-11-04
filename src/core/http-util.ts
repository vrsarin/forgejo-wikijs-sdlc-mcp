export function cookieValue(request: Request, name: string): string | undefined {
  const prefix = `${name}=`
  return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
}

export function isAllowedHost(request: Request, allowedHosts: ReadonlySet<string>): boolean {
  return allowedHosts.has(new URL(request.url).hostname)
}

export function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export function htmlPage(status: number, title: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }
  })
}
