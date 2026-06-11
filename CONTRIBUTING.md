# Contributing

Thanks for your interest in cloakroom!

## Development

```bash
npm install
npm test     # builds + unit, e2e (leak), and jsdom browser tests
```

Node >= 20. No native dependencies, no build step beyond `tsc`.

## Adding an adapter

Adapters make the masking core work against a new data-serving MCP server
(Fabric, SQL, etc.). Implement `SourceAdapter` from `cloakroom-core`:

- `extractHits` — find values-with-column-context in tool results (this is
  the only required method; everything else is progressive enhancement)
- `warmupCall` / `parseWarmupValues` — enumerate a column's distinct values
- `prepare` / `listModels` — session setup and model discovery
- `isWriteCall` — power the readOnly mode
- `listColumns` / `columnSamples` — schema discovery for the admin UI

Ship fixtures captured from the REAL server with your PR (see
`packages/cli/src/test/fixtures/fake-upstream.ts` and the adapter tests for
the pattern). Result shapes observed in the wild beat shapes from docs.

## The bar for masking changes

Any change touching the pipeline, sweep, or store must keep the leak tests
green and should add one: seed sensitive values, assert zero occurrences in
any client-bound byte. Fail closed beats fail open.
