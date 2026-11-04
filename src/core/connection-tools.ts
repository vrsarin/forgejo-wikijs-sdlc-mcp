import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/server'

type Elicit = (params: { mode: 'url'; message: string; url: string; elicitationId: string }) => Promise<{ action: string }>

export interface McpRequestContext {
  mcpReq?: { elicitInput?: Elicit }
  http?: { req?: Request; authInfo?: { clientId?: string; extra?: Record<string, unknown> } }
}

export interface UserOAuth {
  accessToken(subject: string): Promise<string | undefined>
  beginConnect(subject: string): Promise<string>
  disconnect(subject: string): Promise<boolean>
  isConnected(subject: string): Promise<boolean>
  waitForGrant(subject: string, timeoutMs: number): Promise<boolean>
}

export const toolResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
})

/** The identity vouched for by the gateway. Static-token callers intentionally have no subject. */
export function subjectOf(context?: McpRequestContext): string | undefined {
  const subject = context?.http?.authInfo?.extra?.subject
  return typeof subject === 'string' && subject ? subject : undefined
}

export async function offerConnection(
  context: McpRequestContext,
  oauth: UserOAuth,
  subject: string,
  url: string,
  message: string
): Promise<boolean> {
  const elicit = context.mcpReq?.elicitInput
  if (!elicit) return false
  try {
    const answer = await elicit({ mode: 'url', message, url, elicitationId: randomUUID() })
    if (answer.action !== 'accept') return false
  } catch {
    return false
  }
  return oauth.waitForGrant(subject, 120_000)
}

export interface ConnectionToolOptions {
  id: string
  label: string
  oauth: UserOAuth
  connectDescription: string
  disconnectDescription: string
  connectNote: string
  alreadyConnectedNote: string
}

export function connectionToolDefinitions(options: Pick<ConnectionToolOptions, 'id' | 'connectDescription' | 'disconnectDescription'>) {
  return [
    { name: `connect_${options.id}`, description: options.connectDescription, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: `disconnect_${options.id}`, description: options.disconnectDescription, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ]
}

export interface CredentialOptions {
  id: string
  label: string
  header: string
  oauth?: UserOAuth
  stdioToken?: string
  required: boolean
  credentialName?: string
  offerMessage: string
  approvalHint: string
}

/** Resolves credentials in one order for every provider: request header, stdio, stored grant, then consent. */
export function resolveCallerCredential(context: McpRequestContext | undefined, options: CredentialOptions & { required: true }): Promise<string>
export function resolveCallerCredential(context: McpRequestContext | undefined, options: CredentialOptions): Promise<string | undefined>
export async function resolveCallerCredential(context: McpRequestContext | undefined, options: CredentialOptions): Promise<string | undefined> {
  const supplied = context?.http?.req?.headers.get(options.header)?.trim()
  if (supplied) return supplied
  if (options.stdioToken && !context?.http) return options.stdioToken
  const subject = subjectOf(context)
  if (options.oauth && subject) {
    const stored = await options.oauth.accessToken(subject)
    if (stored) return stored
    if (options.required) {
      const link = await options.oauth.beginConnect(subject)
      if (await offerConnection(context ?? {}, options.oauth, subject, link, options.offerMessage)) {
        const connected = await options.oauth.accessToken(subject)
        if (connected) return connected
      }
      throw new Error(`${options.label} is not connected for you. ${options.approvalHint} (or call connect_${options.id} for a new link): ${link}`)
    }
  }
  if (!options.required) return undefined
  throw new Error(`No ${options.label} credential for this caller. ${options.oauth ? `Sign in with Keycloak and call connect_${options.id}` : `Send your ${options.label} ${options.credentialName ?? 'access token'} in the ${options.header} header`}; this server does not use a shared ${options.label} credential.`)
}

export function registerConnectionTools(server: McpServer, options: ConnectionToolOptions): void {
  const { label, oauth } = options
  const [connect, disconnect] = connectionToolDefinitions(options)
  server.registerTool(connect!.name, {
    description: connect!.description,
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
  }, async (context: McpRequestContext) => {
    const subject = subjectOf(context)
    if (!subject) throw new Error(`Sign in with Keycloak first; connecting ${label} needs a verified user identity.`)
    if (await oauth.isConnected(subject)) return toolResult({ connected: true, note: options.alreadyConnectedNote })
    return toolResult({ connected: false, authorizeUrl: await oauth.beginConnect(subject), validForMinutes: 10, note: options.connectNote })
  })
  server.registerTool(disconnect!.name, {
    description: disconnect!.description,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
  }, async (context: McpRequestContext) => {
    const subject = subjectOf(context)
    if (!subject) throw new Error('Sign in with Keycloak first.')
    return toolResult({ disconnected: await oauth.disconnect(subject) })
  })
}
