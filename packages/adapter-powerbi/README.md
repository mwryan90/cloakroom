# cloakroom-adapter-powerbi

Power BI / semantic model adapter for [cloakroom](https://github.com/mwryan90/cloakroom), a masking proxy for MCP servers. Parses DAX result headers (`Customer[Customer Name]`), runs `EVALUATE VALUES(...)` warm-up scans, and lists write tools for read-only mode — targeting [powerbi-modeling-mcp](https://github.com/microsoft/powerbi-modeling-mcp).

Most users want the [`cloakroom`](https://www.npmjs.com/package/cloakroom) CLI package, which includes this adapter:

```bash
npx cloakroom setup
```

MIT licensed.
