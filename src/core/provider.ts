export type ProviderId = 'forgejo' | 'wikijs' | 'homeassistant'

export interface ProviderDefinition {
  id: ProviderId
  displayName: string
  resourceName: string
  runtimeName: string
}

export function oauthPaths(provider: Pick<ProviderDefinition, 'id'>) {
  const prefix = `/oauth/${provider.id}`
  return { prefix, start: `${prefix}/start`, callback: `${prefix}/callback`, loginStart: `${prefix}/login/start`, loginCallback: `${prefix}/login/callback` }
}

/** Extension point implemented by provider adapters and selected by PROVIDER at runtime. */
export abstract class ProviderApplication {
  abstract readonly definition: ProviderDefinition

  abstract start(env: NodeJS.ProcessEnv): Promise<void>
}

export function selectProvider(value: string | undefined): ProviderId {
  if (value === 'forgejo' || value === 'wikijs' || value === 'homeassistant') return value
  throw new Error('PROVIDER must be one of: forgejo, wikijs, homeassistant')
}
