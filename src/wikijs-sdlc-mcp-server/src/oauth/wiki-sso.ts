interface WikiSsoOptions {
  wikiUrl: URL
  callbackUrl: URL
  fetch?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export async function beginWikiSso(request: Request, options: WikiSsoOptions): Promise<Response> {
  const consent = new URL(request.url)
  if (request.method !== 'GET' || consent.hostname !== options.wikiUrl.hostname ||
    consent.pathname !== '/_authorize' || consent.search.length > 8192 ||
    consent.searchParams.getAll('redirect_uri').length !== 1 ||
    consent.searchParams.get('redirect_uri') !== options.callbackUrl.toString()) {
    return new Response('Invalid Wiki.js authorization redirect.', { status: 400 })
  }
  try {
    const fetcher = options.fetch ?? globalThis.fetch
    const infoUrl = new URL('/_api/oauth/authorize', options.wikiUrl.origin)
    infoUrl.search = consent.search
    const cookie = request.headers.get('cookie')
    const session = await fetcher(infoUrl, {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      ...(cookie ? { headers: { cookie } } : {})
    })
    consent.searchParams.set('mcp_sso', '1')
    const redirect = consent.pathname + consent.search
    if (session.ok) {
      const info: unknown = await session.json()
      if (!isRecord(info)) throw new Error('Wiki.js returned an invalid consent response')
      if (info.mayUse !== false) {
        return new Response(null, { status: 302, headers: { location: redirect, 'cache-control': 'no-store' } })
      }
    } else if (session.status !== 401) {
      throw new Error(`Wiki.js session check failed (HTTP ${session.status})`)
    }
    const bootstrapUrl = new URL('/_api/bootstrap', options.wikiUrl.origin)
    bootstrapUrl.searchParams.set('hostname', options.wikiUrl.hostname)
    const bootstrap = await fetcher(bootstrapUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!bootstrap.ok) throw new Error(`Wiki.js bootstrap failed (HTTP ${bootstrap.status})`)
    const siteData: unknown = await bootstrap.json()
    if (!isRecord(siteData) || !isRecord(siteData.site) || !uuid(siteData.site.id)) throw new Error('Wiki.js returned an invalid site ID')
    const siteId = siteData.site.id
    const strategiesUrl = new URL(`/_api/sites/${siteId}/auth/strategies`, options.wikiUrl.origin)
    strategiesUrl.searchParams.set('visibleOnly', 'true')
    const response = await fetcher(strategiesUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Wiki.js authentication discovery failed (HTTP ${response.status})`)
    const strategies: unknown = await response.json()
    if (!Array.isArray(strategies)) throw new Error('Wiki.js returned invalid authentication strategies')
    const matches = strategies.filter((item: unknown) => isRecord(item) && item.isVisible === true && isRecord(item.activeStrategy) &&
      item.activeStrategy.displayName === 'Keycloak' && isRecord(item.activeStrategy.strategy) && item.activeStrategy.strategy.key === 'oidc' && uuid(item.id))
    if (matches.length !== 1 || !uuid(matches[0]?.id)) throw new Error('Wiki.js must have exactly one visible Keycloak OIDC strategy')
    const target = new URL(`/_api/auth/${matches[0].id}/authorize`, options.wikiUrl.origin)
    target.search = new URLSearchParams({ siteId, redirect }).toString()
    return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('Wiki.js SSO discovery failed:', error instanceof Error ? error.message : 'unknown error')
    return new Response('Unable to start Wiki.js sign-in. Check the MCP server logs.', { status: 502, headers: { 'cache-control': 'no-store' } })
  }
}
