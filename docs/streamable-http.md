# Run and test an MCP server

## Purpose

Use this guide to run an MCP server with Streamable HTTP or standard input/output (`stdio`).

The Compose files start only the MCP servers. They do not install Forgejo, Wiki.js, Home Assistant, an identity provider, or an MCP gateway. Supply the provider services that you need.

## Select a transport

| Use case | Transport |
| --- | --- |
| One local VS Code user | `stdio` |
| Local container test | Streamable HTTP |
| Shared test or production | Streamable HTTP with OIDC and TLS |
| Home Assistant | Streamable HTTP with OIDC |

## Test local images with Streamable HTTP

### Prerequisites

- Docker with Compose v2
- Node.js 22 or later
- A reachable Forgejo or Wiki.js service
- A provider token with the minimum required permissions

### Procedure

1. Copy the environment template.

   ```bash
   cp .env.streamable-http.example .env.streamable-http
   ```

2. Set the provider URL and the Forgejo repository allowlist in `.env.streamable-http`.

   Use `host.docker.internal` to reach a host service from the container. The Compose file adds the required Linux `host-gateway` mapping.

3. Build the local images.

   ```bash
   make images
   ```

4. Start the required profiles.

   ```bash
   docker compose --env-file .env.streamable-http \
     -f compose.streamable-http.yaml \
     --profile forgejo --profile wikijs \
     up -d --build --wait
   ```

   The default configuration binds each port to `127.0.0.1`. It disables OIDC and TLS. It also disables Forgejo write tools.

   > **Warning:** Use this configuration only on an isolated workstation.

5. Test each Streamable HTTP endpoint.

   ```bash
   node scripts/smoke-streamable-http.mjs http://127.0.0.1:3010/mcp
   node scripts/smoke-streamable-http.mjs http://127.0.0.1:3011/mcp
   ```

   Each successful command prints `PASS`, the negotiated protocol version, and the number of tools.

The smoke test sends `initialize`, `notifications/initialized`, and `tools/list`. Provider-backed tool calls require `X-Forgejo-Token` or `X-WikiJS-Token`, unless you configure the provider OAuth flow. Do not store a provider token in a committed client file.

## Test with VS Code and stdio

The `.vscode/mcp.json` file defines these local servers:

- `forgejo-workflow-stdio`
- `wikijs-sdlc-stdio`

1. Install dependencies and build the server code.

   ```bash
   make install
   make build
   ```

2. Open **MCP: List Servers** in VS Code.

3. Start the required `-stdio` server.

4. Enter the provider URL and token when VS Code prompts for them.

VS Code treats the token input as a password. The repository file does not contain the token. The configuration starts compiled JavaScript with `node`. This prevents package-manager output from entering the MCP stdout protocol.

The `stdio` transport is for one local user:

- Forgejo uses `FORGEJO_ACCESS_TOKEN`. The checked-in configuration disables write tools.
- Wiki.js uses `WIKIJS_ACCESS_TOKEN`. The server accepts this process credential only with the `stdio` transport.
- Home Assistant does not support `stdio`. It requires OIDC identities and per-user consent.

## Test a released image

1. Set each image variable to a release version or immutable digest.

   ```env
   FORGEJO_MCP_IMAGE=ghcr.io/vrsarin/forgejo-mcp-server:1.0.0
   WIKIJS_SDLC_MCP_IMAGE=ghcr.io/vrsarin/wikijs-sdlc-mcp-server:1.0.0
   HOMEASSISTANT_MCP_IMAGE=ghcr.io/vrsarin/homeassistant-mcp-server:1.0.0
   ```

2. Pull the selected profiles.

   ```bash
   docker compose --env-file .env.streamable-http \
     -f compose.streamable-http.yaml \
     --profile forgejo --profile wikijs pull
   ```

3. Start the containers without a local build.

   ```bash
   docker compose --env-file .env.streamable-http \
     -f compose.streamable-http.yaml \
     --profile forgejo --profile wikijs \
     up -d --no-build --wait
   ```

Public GitHub Container Registry packages support anonymous pulls. A private package requires `docker login ghcr.io` and a token with `read:packages` permission.

## Deploy to a shared environment

Do not use the development defaults in a shared environment.

1. Set `ENABLE_OIDC=true`.
2. Set the issuer, public resource URL, audience, and required role.
3. Set `ENABLE_TLS=true`.
4. Add `-f compose.streamable-http-tls.yaml` to each Compose command.
5. Mount a different certificate directory for each MCP server.
6. Pin each image to a release version or digest.
7. Supply secrets through an approved secret manager.
8. Keep `SDLC_ENABLE_WRITES=false` until you verify read-only behavior and the repository allowlist.

Example OIDC settings:

```env
ENABLE_OIDC=true
MCP_OIDC_ISSUER=https://login.example.com/realms/sdlc
MCP_OIDC_REQUIRED_REALM_ROLE=mcp-user
FORGEJO_MCP_PUBLIC_URL=https://forgejo-mcp.example.com/mcp
FORGEJO_MCP_OIDC_AUDIENCE=https://forgejo-mcp.example.com/mcp
WIKIJS_MCP_PUBLIC_URL=https://wikijs-mcp.example.com/mcp
WIKIJS_MCP_OIDC_AUDIENCE=https://wikijs-mcp.example.com/mcp
```

The TLS override expects `tls.crt` and `tls.key` in `.data/tls/<service>` by default. Set the applicable `*_MCP_TLS_DIR` variable to use a different directory. See [Secure deployment](deployment-security.md) for all security requirements.

## Configure the Home Assistant adapter

Home Assistant is not part of the unauthenticated quick test. Its adapter requires:

- an OIDC issuer and audience;
- a verified Home Assistant HTTPS endpoint at `https://home-assistant-upstream-tls`;
- a 32-byte, base64-encoded token-encryption key;
- a file that contains the discovery identity UUID;
- Home Assistant OIDC and MCP integrations that use the same identity system.

Provide these values and the required Docker network in a deployment override. Then start the `homeassistant` profile. Use an external integration harness for identity-provider, gateway, and end-to-end tests.

## Stop the local test

Stop the containers without deleting MCP data:

```bash
docker compose --env-file .env.streamable-http \
  -f compose.streamable-http.yaml down
```

> **Warning:** The next command deletes encrypted provider grants and all other data in the Compose volumes.

To delete the data, add `--volumes`:

```bash
docker compose --env-file .env.streamable-http \
  -f compose.streamable-http.yaml down --volumes
```

## Troubleshoot a failure

| Symptom | Corrective action |
| --- | --- |
| HTTP 403 with `Host is not allowed` | Add only the required server name to the applicable allowed-hosts variable. |
| HTTP 401 from `/mcp` | Supply a token with the configured issuer, resource or audience, and role. |
| A provider tool reports no credential | Supply the provider token header or complete the provider OAuth consent flow. |
| The server rejects a provider HTTP URL | Use HTTPS. Enable the provider-specific insecure HTTP setting only for an isolated local test. |
| TLS startup fails | Confirm that `tls.crt` and `tls.key` are readable, match, and cover the public server name. |
| A VS Code `stdio` server does not start | Run `make install` and `make build`, and then inspect the MCP server output in VS Code. |
