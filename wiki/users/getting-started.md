# Get started

This guide helps you choose and connect to a server. It covers local use and the repository's local container setup. It does not configure Forgejo, Wiki.js, Home Assistant, an identity provider, or a gateway.

## Choose a server

| Server               | Use it to                                                                                        | Authentication model                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Forgejo Workflow MCP | Read repository and issue data, and optionally perform guarded issue and pull-request operations | A caller's Forgejo token or an approved Forgejo OAuth connection; HTTP callers are authenticated at the MCP endpoint |
| Wiki.js SDLC MCP     | Discover the Wiki.js MCP tools available to a caller                                             | A caller's Wiki.js token or an approved Wiki.js OAuth connection; HTTP callers are authenticated at the MCP endpoint |
| Home Assistant MCP   | Discover and call Home Assistant tools as an authenticated user                                  | OIDC is required; access is bound to the verified user and granted Home Assistant connection                         |

Use the standard input/output (`stdio`) transport for one local user when it is supported. Use Streamable HTTP for a container or shared service. Home Assistant supports HTTP only.

## Connect with VS Code over stdio

This procedure configures the Forgejo or Wiki.js server in the checked-in `.vscode/mcp.json` file.

Prerequisites:

- Node.js 22 or later.
- A reachable Forgejo instance or Wiki.js MCP endpoint.
- A provider token with only the permissions you need.

1. Install dependencies and build the server.

   ```sh
   make install
   make build
   ```

2. Open **MCP: List Servers** in VS Code.

3. Start `forgejo-workflow-stdio` or `wikijs-sdlc-stdio`.

4. Enter the provider URL and token when VS Code prompts you.

5. For Forgejo, enter a comma-separated repository allowlist. Write tools remain disabled in the checked-in configuration.

VS Code stores the token input as a password. Do not put a real token in a committed client configuration. The stdio configuration starts the built JavaScript with `node`.

## Run a local container test

This procedure starts the Forgejo and Wiki.js HTTP servers on loopback. The sample disables endpoint OIDC and TLS and permits insecure upstream HTTP. It is for an isolated workstation only.

Prerequisites:

- Docker with Compose v2.
- A reachable Forgejo or Wiki.js instance.

1. Copy the local environment template.

   ```sh
   cp .env.streamable-http.example .env.streamable-http
   ```

2. Set the provider URLs and the Forgejo repository allowlist in `.env.streamable-http`.

3. Build the image.

   ```sh
   make images
   ```

4. Start the Forgejo and Wiki.js profiles.

   ```sh
   docker compose --env-file .env.streamable-http \
     -f compose.streamable-http.yaml \
     --profile forgejo --profile wikijs \
     up -d --build --wait
   ```

5. Check each endpoint.

   ```sh
   node scripts/smoke-streamable-http.mjs http://127.0.0.1:3010/mcp
   node scripts/smoke-streamable-http.mjs http://127.0.0.1:3011/mcp
   ```

Each successful check prints `PASS`, the negotiated protocol version, and the number of tools. Provider calls need a caller token header or a configured provider OAuth flow.

> **Warning:** Do not expose this default setup to a shared or untrusted network. Enable OIDC and TLS before using an HTTP server in a shared environment.

To stop the local test without deleting its volumes:

```sh
docker compose --env-file .env.streamable-http \
  -f compose.streamable-http.yaml down
```

## Next steps

- Use the [Forgejo setup guide](forgejo.md), [Wiki.js setup guide](wikijs.md), or [Home Assistant setup guide](home-assistant.md) for provider-specific requirements.
- Use [Configuration reference](../reference/configuration.md) to review common environment settings.
- Use [Troubleshooting](../troubleshooting/common-issues.md) when startup or connection checks fail.
