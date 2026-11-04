import { selectProvider, type ProviderApplication, type ProviderId } from './core/provider.js'

const providers: Record<ProviderId, () => Promise<ProviderApplication>> = {
  forgejo: async () => { const { Provider } = await import('./providers/forgejo/runtime.js'); return new Provider() },
  wikijs: async () => { const { Provider } = await import('./providers/wikijs/runtime.js'); return new Provider() },
  homeassistant: async () => { const { Provider } = await import('./providers/homeassistant/runtime.js'); return new Provider() }
}

await (await providers[selectProvider(process.env.PROVIDER)]()).start(process.env)
