# Add a provider

This guide describes the existing provider extension point. It is intended for contributors adding another MCP-backed service to this codebase, not for creating a standalone MCP server from scratch.

## Before you start

- Identify whether the new integration needs the shared MCP transport, HTTP authentication, caller identity, OAuth, or encrypted storage.
- Define its default permissions and the denied paths that must be tested.
- Decide whether the provider is allowed over stdio. Home Assistant is HTTP-only.

## Extension outline

1. Create a provider directory under `src/providers/<provider>/`.

2. Add a `ProviderDefinition` with a stable provider ID, display name, resource name, and runtime name.

3. Implement a `ProviderApplication` that validates configuration and starts the provider. Reuse shared core components for common transport, auth, credential, OAuth-route, and storage behavior where they apply.

4. Implement the provider client and MCP tools. Validate tool inputs with the repository's schema patterns. Mark read-only tools accurately. Keep mutations disabled by default, scoped, explicitly confirmed, and verified with provider read-back where applicable.

5. Register the provider in `src/index.ts` so `PROVIDER` selects it. Update `selectProvider` and the `ProviderId` type in `src/core/provider.ts`.

6. Add provider tests under `test/providers/<provider>/`. Include valid configuration, invalid configuration, allowed requests, denied requests, credential handling, and failures at the upstream boundary.

7. Integrate the provider into its required configuration surfaces: example environment files, Compose profile and service, client examples, and container/runtime checks. Do not add a credential to a committed example.

8. Update the wiki with setup, configuration, permissions, and troubleshooting guidance. Review root README references if the provider changes the public feature summary.

9. Run the relevant tests and checks. See [Run tests](testing.md).

## Review checklist

- Unknown provider IDs fail closed with a useful startup error.
- Required settings are validated rather than silently defaulted.
- Secrets are not logged or checked in.
- Provider operations use the intended caller identity.
- The default write posture is non-mutating.
- Network calls use bounded timeouts and validate response data.
- Tests cover both allowed behavior and expected rejection.
