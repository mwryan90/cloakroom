# Changelog

## 0.3.2

- README: prerequisites in the quickstart — Node >= 20 install guidance
  (nodejs.org / winget), PATH troubleshooting, and the requirement for an
  existing Power BI MCP entry in Claude Desktop. Docs only, no code changes.
- All packages bumped in lockstep.

## 0.3.1

- CLI prints a clear, boxed "admin UI is running / open in your browser: <url>"
  banner so the port is obvious amid the upstream server's startup logs.
- Security review hardening: block `file://` resource reads through the proxy,
  escape `]` in DAX identifiers, scrub example fixtures of any real data.

## 0.3.0 — first public release

- Masking proxy for MCP servers: deterministic, bidirectional value↔token
  pseudonymization with warm-up scans, global sweep over all tool results,
  prompts, resources, and error messages; unknown tokens fail closed.
- Power BI adapter (powerbi-modeling-mcp): CSV/JSON result parsing,
  auto-connect to Power BI Desktop, multi-model warm-up and switching.
- Admin UI (localhost-only): column triage with suggestions, cardinality-aware
  mapping grid, exclude lists, dismissals, searchable mappings browser,
  model switcher, warm-up on rule save. Browser-tested in CI via jsdom.
- `cloakroom setup` wires the proxy into Claude Desktop's config automatically;
  `unwrap` reverts it. masking.yaml hot-reloads into running processes.
- Hardening: cross-process store consistency, CSRF/host guards on the UI,
  masked upstream logs, temp-file path redaction, short-value word boundaries.
