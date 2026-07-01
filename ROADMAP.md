# Roadmap

Cloakroom's north star: **generic, vendor-neutral masking middleware between
any AI agent and any data-serving MCP server.** The core is server-agnostic;
each new data source is a small [`SourceAdapter`](CONTRIBUTING.md#adding-an-adapter).

This roadmap is deliberately public so the work decomposes into
well-scoped, independently testable units. Adapter contributions especially
are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Shipped

- Masking pipeline: deterministic, bidirectional value↔token mapping;
  warm-up scans; global sweep over all tool results, prompts, resources, and
  error messages; unknown tokens fail closed.
- Case-insensitive sweep (masks `UPPER()`-transformed values).
- Power BI adapter (powerbi-modeling-mcp): DAX result parsing, auto-connect
  to Power BI Desktop, multi-model warm-up.
- Admin UI: column triage, cardinality-aware mapping grid, exclude lists,
  restorable skips, bulk "mask all text", prefix re-tokening, token decoder.
- Power BI External Tools ribbon integration.
- Generic mode (`--adapter none`): global sweep against any MCP server.
- Published to npm; leak-test suite in CI across OS/Node versions.

## Next

- **Request-context threading** — pass tool-call arguments into outbound
  masking so adapters can qualify columns by entity/table for MCP servers
  whose results aren't self-describing. Unblocks most new adapters.
- **Remote HTTP upstream transport (+ OAuth passthrough)** — today Cloakroom
  proxies a stdio child process; remote MCP servers need an HTTP client
  transport. Shared infrastructure for every hosted server below.

## Planned adapters

Prioritized by fit with the existing model:

- **Fabric Real-Time Intelligence (Eventhouse/KQL)** — strong fit; KQL
  `distinct`/`summarize` makes warm-up clean; local server is open source.
- **SQL via Data API Builder MCP** — entity-based reads; warm-up via
  `aggregate_records` distinct/groupby (DAB 2.0).
- **Databricks (Genie / SQL / Unity Catalog functions)** — tabular results;
  gated on the remote transport and on positioning vs. native Unity Catalog
  column masking.

## Under consideration

- Numeric scaling as a per-column option (documented inference trade-off).
- High-cardinality strategies: scan caps, sample-based warm-up.
- Per-model / per-source mapping stores for multi-tenant isolation.
- "Rename rule" UI action that re-points a rule at a renamed column while
  preserving token numbering.

Ideas and adapter requests: please open an issue.
