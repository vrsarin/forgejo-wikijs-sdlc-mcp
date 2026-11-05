# Set up local development

This procedure installs the project dependencies, builds the application, and runs its checks.

## Prerequisites

- Node.js 22 or later.
- GNU Make.
- Docker with Compose v2 to build images, validate Compose files, or run `make verify`.

## Install and build

1. Install the locked dependencies and enable the repository hooks.

   ```sh
   make install
   ```

2. Build the application.

   ```sh
   make build
   ```

3. Run the TypeScript checks, lint, and unit tests.

   ```sh
   make check
   make lint
   make test
   ```

The build writes `dist/index.js`. The checked-in VS Code stdio configuration uses this compiled entry point.

## Run an MCP provider locally

For a local Forgejo or Wiki.js stdio connection, configure the provider and required upstream credentials. The repository's `.vscode/mcp.json` file prompts for those values and avoids storing tokens in the file.

To run from the command line after building, set the provider-specific environment variables and run:

```sh
node dist/index.js
```

For example, set `PROVIDER=forgejo`, `MCP_TRANSPORT=stdio`, `FORGEJO_URL`, `FORGEJO_ACCESS_TOKEN`, and `SDLC_ALLOWED_REPOSITORIES`. For Wiki.js, set `PROVIDER=wikijs`, `MCP_TRANSPORT=stdio`, `WIKIJS_MCP_URL`, and `WIKIJS_ACCESS_TOKEN`.

Home Assistant requires HTTP and OIDC. Use its deployment configuration and an external integration harness; it is not a local stdio server.

## Run the full local verification

Run the repository verification target when you need the full local suite:

```sh
make verify
```

It includes lint, dependency audit, type checks, coverage tests, and Compose configuration checks. Container image builds and scans have separate Make targets. See the root [Contributing guide](../../CONTRIBUTING.md) for the repository workflow.
