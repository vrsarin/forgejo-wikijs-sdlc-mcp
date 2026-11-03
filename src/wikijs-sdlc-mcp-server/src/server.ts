import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import type { WikiJsOAuth } from './oauth/wikijs-oauth.js'
import { WIKIJS_TOKEN_HEADER, type WikiJsClient } from './providers/wikijs.js'

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

type Elicit = (params: { mode: 'url'; message: string; url: string; elicitationId: string }) => Promise<{ action: string }>
interface Context { mcpReq?: { elicitInput?: Elicit }; http?: { req?: Request; authInfo?: { clientId?: string; extra?: Record<string, unknown> } } }

/** The identity Keycloak vouched for; static-token callers have none, so they cannot use stored grants. */
const subjectOf = (context: Context): string | undefined => {
  const subject = context.http?.authInfo?.extra?.subject
  return typeof subject === 'string' && subject ? subject : undefined
}

/**
 * Asks the client to open the Wiki.js consent page (URL-mode elicitation, MCP 2025-11-25) and waits for the
 * user to finish it. Returns false when the client cannot do that or the user declines, so the caller falls
 * back to an error that carries the link.
 */
async function offerConnection(context: Context, oauth: WikiJsOAuth, subject: string, url: string): Promise<boolean> {
  const elicit = context?.mcpReq?.elicitInput
  if (!elicit) return false
  try {
    const answer = await elicit({ mode: 'url', message: 'Connect your Wiki.js account so this server can read as you. Check the account and scopes shown on the Wiki.js page and approve.', url, elicitationId: randomUUID() })
    if (answer.action !== 'accept') return false
  } catch {
    return false // the client does not support URL elicitation
  }
  return oauth.waitForGrant(subject, 120_000)
}

export function createWikiJsSdlcServer(wikiJsMcpUrl?: URL, wikiJs?: WikiJsClient, oauth?: WikiJsOAuth, stdioToken?: string): McpServer {
  const server = new McpServer({ name: 'wikijs_sdlc', version: '0.3.0' })

  /** The caller's own Wiki.js credential: an explicit header wins, otherwise their stored OAuth grant. */
  const wikiJsToken = async (context: Context): Promise<string> => {
    const supplied = context.http?.req?.headers.get(WIKIJS_TOKEN_HEADER)?.trim()
    if (supplied) return supplied
    if (stdioToken && !context.http) return stdioToken
    const subject = subjectOf(context)
    if (oauth && subject) {
      const stored = await oauth.accessToken(subject)
      if (stored) return stored
      const link = await oauth.beginConnect(subject)
      if (await offerConnection(context, oauth, subject, link)) {
        const connected = await oauth.accessToken(subject)
        if (connected) return connected
      }
      throw new Error(`Wiki.js is not connected for you. Open this link in the browser where you are signed in to Wiki.js as yourself, check the account and scopes shown, approve, then repeat your request (or call connect_wikijs for a new link): ${link}`)
    }
    throw new Error(`No Wiki.js credential for this caller. ${oauth ? 'Sign in with Keycloak and call connect_wikijs' : `Send your Wiki.js personal access token in the ${WIKIJS_TOKEN_HEADER} header`}; this server does not use a shared Wiki.js credential.`)
  }

  server.registerTool('get_service_status', {
    description: 'Report the Wiki.js SDLC MCP service, the caller identity, and whether this caller has a Wiki.js connection.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async (context: Context) => {
    const subject = subjectOf(context)
    const connection = context.http?.req?.headers.get(WIKIJS_TOKEN_HEADER) ? 'token-header'
      : stdioToken && !context.http ? 'stdio-token'
      : oauth && subject ? ((await oauth.isConnected(subject)) ? 'connected' : 'not-connected') : 'unavailable'
    return json({
      service: 'wikijs_sdlc',
      caller: context.http?.authInfo?.clientId ?? 'stdio-client',
      oauthClient: context.http?.authInfo?.extra?.authorizedParty,
      tokenAudience: context.http?.authInfo?.extra?.audience,
      wikiJsMcpConfigured: Boolean(wikiJsMcpUrl),
      wikiJsOAuthAvailable: Boolean(oauth),
      wikiJsConnection: connection,
      ...(wikiJsMcpUrl ? { wikiJsOrigin: wikiJsMcpUrl.origin } : {})
    })
  })

  if (oauth) {
    server.registerTool('connect_wikijs', {
      description: 'Start a one-time Wiki.js sign-in for the calling user. Returns a link to open in your browser, where Wiki.js asks you to approve access. After approval this server can read Wiki.js as you; nothing needs to be pasted.',
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
    }, async (context: Context) => {
      const subject = subjectOf(context)
      if (!subject) throw new Error('Sign in with Keycloak first; connecting Wiki.js needs a verified user identity.')
      if (await oauth.isConnected(subject)) return json({ connected: true, note: 'Wiki.js is already connected for you. Call disconnect_wikijs first to connect a different account.' })
      return json({ connected: false, authorizeUrl: await oauth.beginConnect(subject), validForMinutes: 10, note: 'Open this link in the browser where you are signed in to Wiki.js as yourself, check the account and scopes shown, and approve.' })
    })
    server.registerTool('disconnect_wikijs', {
      description: 'Forget the calling user\'s stored Wiki.js grant on this server. To revoke it at Wiki.js too, delete the connection under Profile → Access Tokens in Wiki.js.',
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    }, async (context: Context) => {
      const subject = subjectOf(context)
      if (!subject) throw new Error('Sign in with Keycloak first.')
      return json({ disconnected: await oauth.disconnect(subject) })
    })
  }

  server.registerTool('discover_wikijs_capabilities', {
    description: 'Connect to the official Wiki.js MCP endpoint as the calling user and list the tools that user may use.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async (context: Context) => {
    if (!wikiJs) throw new Error('WIKIJS_MCP_URL is not configured')
    const discovery = await wikiJs.discover(await wikiJsToken(context))
    return json({ caller: context.http?.authInfo?.clientId ?? 'stdio-client', ...discovery })
  })
  return server
}
