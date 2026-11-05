# Understand the project

This repository builds one Node.js application and container image. At startup, `PROVIDER` selects one of three provider adapters:

- `forgejo` starts the Forgejo workflow server.
- `wikijs` starts the Wiki.js SDLC server.
- `homeassistant` starts the Home Assistant adapter.

The shared core provides transport, authentication, connection handling, runtime configuration, HTTP security, and shared utilities. Provider-specific code lives in `src/providers/<provider>/`.

## Repository map

| Path                           | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `src/index.ts`                 | Selects and starts the provider                                      |
| `src/core/`                    | Shared MCP runtime, auth, HTTP, config, credential, and storage code |
| `src/providers/forgejo/`       | Forgejo configuration, client, OAuth, and MCP tools                  |
| `src/providers/wikijs/`        | Wiki.js configuration, client, OAuth, and MCP tools                  |
| `src/providers/homeassistant/` | Home Assistant HTTP adapter and OAuth behavior                       |
| `test/core/`                   | Shared core tests                                                    |
| `test/providers/`              | Provider-specific tests                                              |
| `scripts/`                     | Build, validation, release, and local smoke-test scripts             |
| `wiki/`                        | User-facing and developer-facing wiki content                        |

## Request flow

For Forgejo and Wiki.js, the entry point loads the selected provider. The provider parses configuration, creates its upstream client and optional connection flow, builds an MCP server, and starts the configured transport. HTTP callers must pass the configured MCP authentication. Provider operations use the caller's provider credential.

The Home Assistant provider starts an HTTP handler rather than an stdio MCP server. It verifies OIDC identity and uses a user-bound, encrypted grant when communicating with Home Assistant.

## Development principles

- Keep provider-specific behavior inside that provider's directory unless it is genuinely shared.
- Fail startup when required security configuration is missing or contradictory.
- Keep writes disabled by default and constrain them to an explicit scope.
- Use caller credentials for provider operations; do not silently substitute a shared credential for an HTTP caller.
- Test both permitted and denied paths when changing authentication, authorization, transport, or writes.
- Update the relevant wiki page when configuration or user-visible behavior changes.

See [Add a provider](adding-a-provider.md) for the extension outline and [Set up local development](local-development.md) to run checks.
