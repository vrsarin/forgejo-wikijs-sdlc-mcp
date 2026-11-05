# Configuration reference

This page lists the main configuration variables used to select and connect to a provider. The `.env.example` and `.env.streamable-http.example` files provide local examples. Do not copy their insecure development defaults to a shared environment.

## Provider selection and listener

| Variable              | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `PROVIDER`            | Required application selector: `forgejo`, `wikijs`, or `homeassistant` |
| `MCP_TRANSPORT`       | `stdio` selects stdio; otherwise the shared config uses HTTP           |
| `MCP_HOST`            | HTTP bind host; defaults to `0.0.0.0`                                  |
| `MCP_PORT`            | HTTP port; defaults to `3000`                                          |
| `MCP_ALLOWED_HOSTS`   | Comma-separated accepted HTTP hostnames; defaults to loopback names    |
| `MCP_ALLOWED_ORIGINS` | Comma-separated accepted browser origins                               |

Host and origin checks do not authenticate callers.

## MCP endpoint authentication

| Variable                       | Meaning                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_OIDC`                  | Set to `true` to use OIDC on Forgejo and Wiki.js HTTP endpoints; set to `false` to disable it for isolated local development |
| `MCP_OIDC_ISSUER`              | OIDC issuer URL                                                                                                              |
| `MCP_OIDC_RESOURCE`            | Public MCP resource URL                                                                                                      |
| `MCP_OIDC_AUDIENCE`            | Required MCP token audience                                                                                                  |
| `MCP_OIDC_REQUIRED_REALM_ROLE` | Required realm role; configure this or `MCP_OIDC_ROLE_CLIENT_ID`                                                             |
| `MCP_OIDC_ROLE_CLIENT_ID`      | Client whose role claim is required; configure this or the realm role                                                        |
| `MCP_OIDC_REQUIRED_GROUP`      | Required group claim when configured; mandatory for Home Assistant                                                           |
| `MCP_OIDC_DISCOVERY_CLIENT_ID` | Client ID used for Home Assistant discovery identity                                                                         |
| `ENABLE_TLS`                   | Enable native TLS for the HTTP server                                                                                        |
| `TLS_MODE`                     | TLS mode: `static` or `letsencrypt`                                                                                          |
| `TLS_CERT_PATH`                | Certificate path for static TLS; defaults to the Let's Encrypt certificate path in ACME mode                                 |
| `TLS_KEY_PATH`                 | Private-key path for static TLS; defaults to the Let's Encrypt key path in ACME mode                                         |
| `TLS_DOMAIN`                   | Public domain used by Let's Encrypt mode                                                                                     |
| `TLS_EMAIL`                    | Contact email used by Let's Encrypt mode                                                                                     |

Forgejo and Wiki.js support explicit local development without OIDC or TLS. Do not use that mode on a shared or untrusted network. Home Assistant always requires OIDC and an HTTPS upstream.

## Forgejo

| Variable                      | Meaning                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `FORGEJO_URL`                 | Forgejo base URL; required                                              |
| `FORGEJO_ALLOW_INSECURE_HTTP` | Permit an HTTP Forgejo URL for isolated development                     |
| `FORGEJO_ACCESS_TOKEN`        | Shared process credential used only by stdio                            |
| `SDLC_ALLOWED_REPOSITORIES`   | Comma-separated `owner/repository` allowlist                            |
| `SDLC_ENABLE_WRITES`          | Set to `true` to register write tools; otherwise writes are unavailable |

HTTP provider calls use the caller's `X-Forgejo-Token` header or a configured OAuth grant.

To configure the Forgejo OAuth connection flow, set `FORGEJO_OAUTH_CLIENT_ID`, `FORGEJO_OAUTH_CLIENT_SECRET`, `FORGEJO_OAUTH_REDIRECT_URL`, and `FORGEJO_TOKEN_ENCRYPTION_KEY`. The callback path defaults to `/oauth/forgejo/callback`. The encrypted grant file defaults to `/data/forgejo-grants.enc`.

## Wiki.js

| Variable                         | Meaning                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `WIKIJS_MCP_URL`                 | Official Wiki.js MCP endpoint; path must end in `/_mcp` |
| `WIKIJS_ALLOW_INSECURE_MCP_HTTP` | Permit an HTTP upstream for isolated development        |
| `WIKIJS_ACCESS_TOKEN`            | Shared process credential used only by stdio            |

HTTP provider calls use the caller's `X-WikiJS-Token` header or a configured OAuth grant.

To configure the Wiki.js OAuth connection flow, set `WIKIJS_OAUTH_REDIRECT_URL` and `WIKIJS_TOKEN_ENCRYPTION_KEY`. The callback path defaults to `/oauth/wikijs/callback`. `WIKIJS_OAUTH_SCOPES` defaults to `mcp:read pages:read glossary:read`. The encrypted grant file defaults to `/data/wikijs-grants.enc`.

## Home Assistant

| Variable                                    | Meaning                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `HOMEASSISTANT_PUBLIC_URL`                  | Public Home Assistant URL used by the authorization flow                       |
| `HOMEASSISTANT_INTERNAL_URL`                | HTTPS upstream URL reachable by the adapter                                    |
| `HOMEASSISTANT_MCP_OIDC_AUDIENCE`           | OIDC audience for this MCP endpoint                                            |
| `HOMEASSISTANT_MCP_OIDC_REQUIRED_GROUP`     | Required OIDC group; defaults to `home-assistant-users` in the Compose example |
| `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE_HOST` | Host path to a file containing the discovery subject UUID in Compose           |
| `HOMEASSISTANT_TOKEN_ENCRYPTION_KEY`        | Base64-encoded 32-byte encryption key                                          |

The process receives the mounted discovery file path as `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE`. Do not commit the key or identity file.

## Other deployment settings

Provider public URLs, token-store paths, TLS certificate mounting, and container overrides use additional variables. Check the provider runtime and the deployment's environment template before setting them. Provide secrets through a secret manager, not a committed `.env` file.
