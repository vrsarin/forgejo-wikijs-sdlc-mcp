import { McpServer } from '@modelcontextprotocol/server'
import { registerConnectionTools, resolveCallerCredential, subjectOf, toolResult as json, type McpRequestContext as Context } from '../../core/connection-tools.js'
import type { ProviderOAuth } from './provider-oauth.js'
import { WIKIJS_TOKEN_HEADER, type WikiJsClient } from './wikijs.js'


export function createWikiJsSdlcServer(wikiJsMcpUrl?: URL, wikiJs?: WikiJsClient, oauth?: ProviderOAuth, stdioToken?: string): McpServer {
  const server = new McpServer({ name: 'wikijs_sdlc', version: '0.3.0' })

  /** The caller's own Wiki.js credential: an explicit header wins, otherwise their stored OAuth grant. */
  const wikiJsToken = async (context: Context): Promise<string> => resolveCallerCredential(context, {
    id: 'wikijs', label: 'Wiki.js', header: WIKIJS_TOKEN_HEADER, required: true, credentialName: 'personal access token',
    offerMessage: 'Connect your Wiki.js account so this server can read as you. Check the account and scopes shown on the Wiki.js page and approve.',
    approvalHint: 'Open the link in the browser where you are signed in to Wiki.js as yourself, check the account and scopes shown, approve, then repeat your request',
    ...(oauth ? { oauth } : {}), ...(stdioToken ? { stdioToken } : {})
  })

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
      providerOAuthAvailable: Boolean(oauth),
      wikiJsConnection: connection,
      ...(wikiJsMcpUrl ? { wikiJsOrigin: wikiJsMcpUrl.origin } : {})
    })
  })

  if (oauth) {
    registerConnectionTools(server, {
      id: 'wikijs', label: 'Wiki.js', oauth,
      connectDescription: 'Start a one-time Wiki.js sign-in for the calling user. Returns a link to open in your browser, where Wiki.js asks you to approve access. After approval this server can read Wiki.js as you; nothing needs to be pasted.',
      disconnectDescription: 'Forget the calling user\'s stored Wiki.js grant on this server. To revoke it at Wiki.js too, delete the connection under Profile → Access Tokens in Wiki.js.',
      alreadyConnectedNote: 'Wiki.js is already connected for you. Call disconnect_wikijs first to connect a different account.',
      connectNote: 'Open this link in the browser where you are signed in to Wiki.js as yourself, check the account and scopes shown, and approve.'
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
