# Changelog

## 0.3.9

- The admin UI now detects when the Power BI file it connected to has been
  **closed** and reconnects to whatever is open (or reports NOT CONNECTED
  honestly if nothing is). Previously a long-lived UI stayed "connected" to
  a dead session forever. The schema list also refreshes when a reconnect
  lands on a different model.
- Release preflight now checks npm auth up front (an expired login used to
  surface as a misleading 404 after the full test run).

## 0.3.8

- **Multi-source admin UI**: `cloakroom ui` now manages every
  cloakroom-wrapped MCP server in one place. A header picker switches
  between sources; rules, discovery, and triage are scoped per source while
  the mapping store stays shared (same entity → same token everywhere).
  Generic-mode sources (`--adapter none`) show a sweep-only coverage
  summary — what is masked there and what isn't protected — instead of a
  column browser, and their upstream is never spawned by the UI.
- `--server` on `ui` now picks the initially selected source instead of
  limiting the UI to one server.

## 0.3.7

- Repo: added SECURITY.md, ROADMAP.md, CODE_OF_CONDUCT.md, issue/PR
  templates, and README status badges.
- Changing a rule's prefix now offers to rename the existing sequential
  tokens too ("Client 5" → "Customer 5", numbers preserved; custom tokens
  untouched; old names still translate inbound). Previously the new prefix
  silently applied only to future values.
- When the agent uses a token that has since been renamed, the proxy appends
  a notice to the tool result explaining the rename — the filter still
  worked, results show the new name, and the agent is told to use it going
  forward. Notices contain only tokens, never real values.
- `npm run release` now runs a preflight that refuses to publish a version
  the registry already has, from a dirty tree, or behind origin/main —
  three releases went out mid-feature without it.

## 0.3.6

- Branding: "Cloakroom" capitalized in the Power BI ribbon and the admin UI
  header; the logo now appears in the UI header and as the favicon (one
  embedded icon shared by the UI and the ribbon button).
- The admin UI status line labels the masking config path ("config: ...")
  so it reads as the live setting it is.
- Admin UI auto-connects when a Power BI file is opened *after* the UI
  started (previously the connection was only attempted once at startup, so
  a UI launched too early — or reused via the ribbon button — stayed
  "NOT CONNECTED" until restarted). The model list poll (every 15s) now
  reconnects and refreshes the page when a model appears.

## 0.3.5

- **Power BI ribbon button**: `setup` registers cloakroom in Power BI
  Desktop's External Tools ribbon (one click opens the admin UI); `unwrap`
  removes it. Needs an elevated terminal to write under Program Files —
  setup degrades gracefully and `--no-external-tool` skips it.
- `cloakroom ui` now reuses an already-running instance instead of failing
  with "port in use", and `--open` launches the browser.

## 0.3.4

- Admin UI: the "mask all text" confirmation is now a styled in-page modal
  (lists the affected columns; Escape, overlay click, or Cancel dismiss it)
  instead of the browser's native confirm dialog.

## 0.3.3

- **Case-insensitive masking**: the global sweep now catches known values in
  any casing (e.g. a measure returning `UPPER([Customer Name])`). Exact-case
  matches keep their own tokens; case variants get the canonical token.
  Inbound unmasking is unchanged (exact tokens only).
- Admin UI: **mask all text** button per table — adds a token rule (with
  warm-up scan) for every untagged, unskipped text column in one click.
- Admin UI: skipped columns ("Not sensitive") now show a **skipped** badge in
  the column list and can be restored from the detail panel.
- The UI header and MCP client/server versions now come from package.json
  instead of a stale hardcoded string.

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
