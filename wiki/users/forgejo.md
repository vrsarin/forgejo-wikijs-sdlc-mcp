# Set up Forgejo

Forgejo Workflow MCP exposes repository, issue, pull-request, review, and workflow operations. Read operations are available by default. Write tools are opt-in and limited to explicitly allowed repositories.

## Prerequisites

- A reachable Forgejo server.
- For stdio, a Forgejo access token.
- For HTTP, an authenticated MCP caller and a caller Forgejo token or configured Forgejo OAuth connection for provider operations.
- At least one `owner/repository` entry in `SDLC_ALLOWED_REPOSITORIES`.

Give tokens only the Forgejo permissions needed for the planned operations. A repository allowlist limits where this server operates; it does not replace Forgejo permissions.

## Configure stdio

The checked-in VS Code configuration prompts for the Forgejo origin, access token, and repository allowlist. Set `PROVIDER=forgejo` and `MCP_TRANSPORT=stdio` if you configure another client.

Example environment:

```env
PROVIDER=forgejo
MCP_TRANSPORT=stdio
FORGEJO_URL=https://forgejo.example.com
FORGEJO_ACCESS_TOKEN=<token supplied through a secret prompt>
SDLC_ALLOWED_REPOSITORIES=team/service,team/website
SDLC_ENABLE_WRITES=false
```

Do not store a real token in a checked-in file. The server requires `FORGEJO_ACCESS_TOKEN` for stdio.

## Configure an HTTP deployment

Set `PROVIDER=forgejo` and configure the provider URL, listener, caller authentication, and allowed repositories. For example, the repository's Compose service uses port 3010 on loopback and passes `SDLC_ALLOWED_REPOSITORIES` to the server.

HTTP requests use a token supplied by the calling user in the `X-Forgejo-Token` header or an approved OAuth grant. The HTTP server does not use a shared Forgejo access token as the identity of every caller.

The checked-in local Compose template disables OIDC and TLS. It binds to loopback and is for isolated development only. In a shared or production deployment, enable OIDC and TLS and supply secrets through an approved secret manager.

## Enable write tools

Write tools are not registered unless `SDLC_ENABLE_WRITES=true`. Keep the default `false` unless you have reviewed the scope and tested the operations.

When enabled, write tools require explicit confirmation and a reason. Applicable mutations also require an idempotency key. The server checks the repository allowlist, calls Forgejo using the caller's credential, and reads back the result. The caller's Forgejo permissions still apply.

## Verify the connection

Use the MCP client to initialize the server and list its tools. For stdio, ensure the process starts without protocol output or configuration errors. For HTTP, use the local smoke test from [Get started](getting-started.md).

Use the `get_forgejo_connection` tool to inspect connection details, then use a read tool against an allowed repository. A repository outside the allowlist must be rejected.

## Related guides

- [Configuration reference](../reference/configuration.md)
- [Troubleshooting](../troubleshooting/common-issues.md)
