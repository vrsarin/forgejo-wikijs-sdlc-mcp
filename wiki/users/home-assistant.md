# Set up Home Assistant

The Home Assistant adapter exposes Home Assistant MCP capabilities through an authenticated, user-bound connection. It supports Streamable HTTP only. It always requires OpenID Connect (OIDC), a configured user group, and an HTTPS Home Assistant upstream.

## Prerequisites

- A Home Assistant HTTPS endpoint reachable from the adapter.
- An OIDC issuer and client setup that provides the configured audience and group claim.
- A discovery subject UUID in a file mounted read-only into the container.
- A base64-encoded 32-byte token-encryption key.
- Home Assistant and MCP integrations configured to use the same identity system.

The repository Compose example expects the upstream URL to be `https://home-assistant-upstream-tls` by default. Use a valid TLS certificate for the upstream. Do not disable upstream certificate verification.

## Configure the required values

Set the following values in the deployment environment:

| Variable                                    | Purpose                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| `MCP_OIDC_ISSUER`                           | OIDC issuer URL                                          |
| `HOMEASSISTANT_MCP_OIDC_AUDIENCE`           | Audience accepted for this MCP endpoint                  |
| `HOMEASSISTANT_MCP_OIDC_REQUIRED_GROUP`     | Required user group; defaults to `home-assistant-users`  |
| `MCP_OIDC_DISCOVERY_CLIENT_ID`              | Client identity used for the discovery grant             |
| `HOMEASSISTANT_MCP_PUBLIC_URL`              | Public MCP endpoint URL                                  |
| `HOMEASSISTANT_PUBLIC_URL`                  | Public Home Assistant URL used for authorization         |
| `HOMEASSISTANT_INTERNAL_URL`                | HTTPS Home Assistant URL reachable from the adapter      |
| `HOMEASSISTANT_TOKEN_ENCRYPTION_KEY`        | Base64-encoded 32-byte key for encrypted grants          |
| `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE_HOST` | Host path to the discovery identity UUID file in Compose |

The server reads the discovery identity from `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE`. The Compose file mounts the host file specified by `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE_HOST` at this container path. The file must contain a UUID.

Generate a new key for the deployment and store it in a secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Do not commit the generated key or discovery identity file. Restrict access to both.

## Start the adapter

The adapter uses the `homeassistant` profile in `compose.streamable-http.yaml`. Supply the required values and the network configuration that can reach the trusted upstream, then start the profile:

```sh
docker compose --env-file .env.streamable-http \
  -f compose.streamable-http.yaml \
  --profile homeassistant up -d --wait
```

The example publishes port 3012 on loopback. It does not create Home Assistant, the identity provider, or an upstream TLS service. Configure those separately.

## Verify access

Connect an MCP client to the configured endpoint and authenticate with an OIDC token for the expected audience, role, and group. Confirm the client can initialize and list tools, then test only operations allowed to that user in Home Assistant.

Use an external integration harness to test identity provider, gateway, Home Assistant, and end-to-end behavior together.
