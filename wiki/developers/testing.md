# Run tests

The project uses Node's test runner through npm scripts. Tests are grouped by shared core, provider, and helper script.

## Run all unit tests

```sh
make test
```

The `npm test` command runs tests under `test/core/`, `test/providers/`, and the tested scripts.

## Run coverage

```sh
make coverage
```

The coverage command uses `c8` and enforces the configured aggregate line coverage threshold. The generated Cobertura report is under `.coverage/`.

## Run checks

```sh
make check
make lint
```

`make check` runs the TypeScript compiler without emitting files. `make lint` runs ESLint.

## Validate container configuration

When changing Compose settings, run:

```sh
make compose-check
```

This validates the Compose configuration with and without the TLS override. It does not prove that the configured upstream identity provider or application is available.

## Choose relevant regression tests

- Shared authentication, transport, or HTTP changes: run the related `test/core/` suite and the full unit suite.
- Forgejo behavior: run tests in `test/providers/forgejo/`.
- Wiki.js behavior: run tests in `test/providers/wikijs/`.
- Home Assistant behavior: run tests in `test/providers/homeassistant/`.
- Script changes: run the matching `scripts/*.test.mjs` test.

Security-sensitive changes must test the expected rejection path as well as successful access. Do not treat unit tests or Compose syntax validation as end-to-end tests of an identity provider, gateway, or upstream service.
