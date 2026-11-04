# Repository instructions

## Documentation

Before you create, edit, or review repository documentation, read and follow [`docs/documentation.md`](docs/documentation.md).

Treat that file as the canonical documentation policy. Do not copy its rules into another instruction file. Keep AI-provider-specific instruction files as thin adapters to this file.

For documentation work:

1. Identify the intended audience and task.
2. Select the applicable information type: concept, procedure, reference, or troubleshooting.
3. Verify commands, paths, configuration defaults, links, and security statements against the repository.
4. Keep each user-guide topic focused on one task so that it can move to a Wiki without substantial restructuring.
5. Do not publish or update an external Wiki unless the user explicitly authorizes that action.

## Repository skills

Use these repository skills when their scope applies:

- `github-actions-hardening`: Create, change, or review a GitHub Actions workflow.
- `mcp-implementation-security-review`: Review MCP implementation security or assess release readiness for authentication, transport, sessions, input
  validation, or tool execution.
- `mcp-release-qa`: Prepare or review an MCP server release, or verify a change to protocol behavior, transports, or the exposed capability inventory.

When you perform an MCP security review, assess each intended environment separately. Authentication or TLS can be disabled only for an explicitly local development environment. Do not treat that development exception as acceptable for a shared, test, staging, or production deployment.
