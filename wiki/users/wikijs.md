# Set up Wiki.js

Wiki.js SDLC MCP connects to Wiki.js's official MCP endpoint and discovers the tools available to the caller. It does not replace Wiki.js permissions: the tools exposed by the upstream server depend on the caller's Wiki.js credential and access.

## Prerequisites

- A Wiki.js instance with its official MCP endpoint enabled and reachable.
- For stdio, a Wiki.js access token.
- For HTTP, an authenticated MCP caller and a caller Wiki.js token or configured Wiki.js OAuth connection.

The upstream endpoint URL must end in `/_mcp`. Use HTTPS except for an isolated local test where insecure HTTP is explicitly enabled.

## Configure stdio

The checked-in VS Code configuration prompts for the Wiki.js MCP endpoint and access token. Set `PROVIDER=wikijs` and `MCP_TRANSPORT=stdio` if you configure another client.

Example environment:

```env
PROVIDER=wikijs
MCP_TRANSPORT=stdio
WIKIJS_MCP_URL=https://wiki.example.com/_mcp
WIKIJS_ACCESS_TOKEN=<token supplied through a secret prompt>
```

Do not store a real token in a checked-in file. If `WIKIJS_MCP_URL` is configured for stdio, the server requires `WIKIJS_ACCESS_TOKEN`.

## Configure an HTTP deployment

Set `PROVIDER=wikijs`, the upstream URL, and the MCP HTTP listener. The repository's local Compose service listens on port 3011 on loopback and uses `WIKIJS_MCP_URL` for the upstream endpoint.

HTTP requests use a token supplied by the calling user in the `X-WikiJS-Token` header or an approved OAuth grant. The server forwards the caller's credential when discovering upstream tools.

The checked-in local Compose template disables OIDC and TLS and permits insecure upstream HTTP. Use it only on an isolated workstation. Enable OIDC and TLS and provide secrets through an approved secret manager for shared environments.

## Verify the connection

Initialize the MCP server and list its tools. The `get_service_status` tool reports whether the Wiki.js MCP URL is configured and whether the caller has a connection. The `discover_wikijs_capabilities` tool asks the upstream Wiki.js MCP server for the tools available to that caller.

A successful connection does not grant additional Wiki.js permissions. Confirm the account and permissions in Wiki.js if expected tools are missing.

## Related guides

- [Configuration reference](../reference/configuration.md)
- [Troubleshooting](../troubleshooting/common-issues.md)
