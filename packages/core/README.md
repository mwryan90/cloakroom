# cloakroom-core

Server-agnostic core of [cloakroom](https://github.com/mwryan90/cloakroom), a masking proxy for MCP servers: the proxy pipeline, deterministic tokenizers, JSONL mapping store, global sweep, config loader, and the `SourceAdapter` interface.

Most users want the [`cloakroom`](https://www.npmjs.com/package/cloakroom) CLI package, which wires everything together:

```bash
npx cloakroom setup
```

Use this package directly only if you're building a new adapter or embedding the masking pipeline. See the [repository](https://github.com/mwryan90/cloakroom) for the design doc and adapter interface.

MIT licensed.
