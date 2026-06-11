# Power BI MCP Masking Proxy — Design

## Goal

A safeguard layer so that when an LLM uses the Power BI MCP server, sensitive customer data never enters the model's context. Sensitive text values are replaced with stable, deterministic tokens ("Client 1") so structure, grouping, and cross-query references are preserved.

**Long-term vision:** open-source, generic masking middleware between any AI agent and any data-serving MCP server. Power BI is the first adapter; Fabric next; the core works (degraded) with no adapter at all.

## Decisions made

- **Architecture:** standalone proxy MCP server wrapping the upstream Power BI MCP (no fork). Core/adapter split from day one.
- **Tagging:** local config file lists sensitive columns; admin UI generates it.
- **Scope:** text identifiers only — numbers and dates pass through untouched.
- **Stack:** TypeScript (official MCP SDK, `npx` distribution, one language for proxy + UI).
- **Team consistency:** both modes — sequential friendly tokens by default; optional HMAC mode with a shared team secret for cross-machine consistency without syncing.
- **License/publishing:** open source on GitHub (MIT unless decided otherwise).

## Architecture

```
Claude / LLM client
      │  (MCP, stdio)
      ▼
masking-proxy (this project)
      │  (MCP client → spawns upstream as child process)
      ▼
powerbi-modeling-mcp (unmodified)
      ▼
Power BI / Analysis Services
```

The proxy:

1. On startup, connects to the upstream server, calls `tools/list`, and re-exposes every upstream tool with identical schemas. No hardcoded tool knowledge — survives upstream updates.
2. **Inbound (tool calls):** scans string arguments for tokens and replaces them with real values (so a DAX filter on `"Client 1"` actually works).
3. **Outbound (tool results, including errors):** masks sensitive values before returning to the client.

Raw data exists only inside the proxy process. Nothing unmasked is ever written to the MCP transport toward the client, including logs and error messages.

## Core / adapter split

The core is server-agnostic; everything Power BI-specific lives behind a small adapter interface:

```ts
interface SourceAdapter {
  // Map structured tool results to column identities, e.g. parse
  // DAX result headers like Customer[Customer Name]
  extractColumns(toolName: string, result: unknown): ColumnContext[];
  // Queries to enumerate distinct values of a tagged column (warm-up scan)
  warmupCall(column: ColumnRef): ToolCall | null;
  // Optional: tool names that mutate the source (for read-only mode)
  writeTools?: string[];
}
```

Core (adapter-independent): tool mirroring, mapping store, tokenizers, inbound unmasking, **global sweep**, admin UI, logging.

- `adapter-powerbi` (v1): DAX header parsing, `EVALUATE VALUES()` warm-up, write-tool list.
- `adapter-fabric` (future): same interface, different query dialect/result shapes.
- **No adapter (generic mode):** global sweep only — mappings seeded via the admin UI or imported lists. Works against any MCP server, with the caveat that unseen values aren't protected.

Repo layout: monorepo — `packages/core`, `packages/adapter-powerbi`, `packages/ui`, `packages/cli` (the `npx` entry point that wires them together from one config file).

## Config file (`masking.yaml`)

```yaml
mappingStore: ./masking-map.jsonl

columns:
  - match: "Customer[Customer Name]"      # table[column], wildcards allowed
    mask: token
    prefix: "Client"
  - match: "Customer[Email]"
    mask: email                            # client1@masked.example
    linkTo: "Customer[Customer Name]"      # same entity → same index
  - match: "*[*Phone*]"
    mask: token
    prefix: "Phone"
```

Mask types (v1): `token` (Prefix N), `email`. `linkTo` keeps related columns on one index so "Client 1" and "client1@masked.example" are recognisably the same entity.

## Mapping store

Append-only JSONL file, local only (no native dependencies — better-sqlite3 install friction is a known OSS support burden):

```
mappings(column_group TEXT, real_value TEXT, token TEXT,
         UNIQUE(column_group, real_value), UNIQUE(column_group, token))
```

- Deterministic and persistent: same value → same token across queries **and sessions** (stable anchors).
- Token allocation, two modes:
  - **Sequential (default):** next integer per column group → friendly "Client 1". Per-machine unless the store is shared.
  - **Team HMAC mode:** token suffix derived from `HMAC(teamSecret, value)` → "Client_a3f9e2". Same value → same token on every colleague's machine with zero sync; secret distributed out-of-band. Never raw hashing — low-entropy values (names) are trivially reversible by dictionary attack without a keyed secret.
- Lookup is needed in both directions (mask outbound, unmask inbound).
- The store is the secret. It stays on disk locally; the proxy never returns its contents through MCP.

## Warm-up scan (closes the "first exposure" gap)

A value can only be masked if the proxy knows it's sensitive. If a real client name first appears somewhere *without* column context (e.g., embedded as a literal in a measure expression), it would leak.

Fix: on startup (and on demand), the proxy runs `EVALUATE VALUES('Customer'[Customer Name])` against each configured column, registering every distinct value in the mapping store. These queries run inside the proxy; results never reach the client. After warm-up, the global sweep (below) catches those values **anywhere** they appear in any tool output.

## Outbound masking — two layers

1. **Column-aware:** DAX result sets carry fully qualified headers (`Customer[Customer Name]`). Match headers against config; tokenize matching columns. New values get registered on first sight.
2. **Global sweep (safety net):** after column-aware masking, replace any known sensitive value (from the mapping store) appearing in *any* string of *any* tool result — error messages, measure/partition expressions returned by metadata tools, column statistics, sample values in schema responses. Longest-match-first to handle overlapping names.

Layer 2 is what makes this a safeguard rather than a best-effort filter: every value seen in a tagged column (or warm-up scan) can never subsequently appear unmasked in any output.

## Inbound unmasking

- Scan all string arguments (DAX queries, filter expressions) for known tokens (`"Client 12"`, `client12@masked.example`) and substitute real values before forwarding upstream.
- Exact-token match only (quoted strings / word boundaries) to avoid corrupting unrelated text.
- Unknown token (e.g., "Client 999" never allocated) → return an error rather than forwarding a broken query.

## Admin UI (localhost web app)

A lightweight web UI for configuring what's sensitive and how it's pseudonymised. It runs locally, bound to `127.0.0.1` only — it *does* display real data, which is fine: the human owner sees it, the LLM never does. It reads/writes the same `masking.yaml` and mapping store the proxy uses.

**Flow:**

1. **Discover** — pull the model schema upstream; for each text column fetch `DISTINCTCOUNT` and a small sample.
2. **Triage** — columns ranked by likely sensitivity (name/email/phone patterns, high uniqueness, text type). User toggles sensitive yes/no per column.
3. **Strategy per column, driven by cardinality:**
   - **< 50 distinct values:** editable mapping grid pre-filled with `Prefix 1…N`. User can rename tokens to meaningful-but-safe labels (e.g., "BigRetailer"). Saved straight into the mapping store.
   - **≥ 50 distinct values:** automatic strategy — sequential tokens or HMAC-derived (`Client_a3f9`) — populated by the warm-up scan.
4. **Review** — live preview: sample rows shown raw vs. masked side by side before saving.

Manual and auto-generated mappings land in the same table, so the proxy is agnostic about their origin. Token renames must respect the uniqueness constraint and are append-only in effect (renaming a token re-points it; old tokens become invalid for inbound unmasking).

Stack: single small Node/Express (or Hono) server + plain HTML/JS page, no build step. It can share the proxy's upstream connection code as a library.

## Threat model (goes in README, verbatim honesty)

**What it protects against:** accidental exposure of tagged sensitive values to the LLM/agent context — in query results, metadata, expressions, statistics, and error messages — for any value the proxy has seen in a tagged column or warm-up scan.

**What it does NOT protect against:**

- Values never observed in a tagged column (mitigated, not eliminated, by warm-up scans).
- Inference from unmasked data (e.g., identifying the largest client from revenue rank).
- A malicious upstream server or a compromised local machine.
- Numbers/dates by design (v1 scope).

Positioning: a **guardrail against accidental exposure, not a DLP/security boundary**. Stating this clearly is what makes it publishable.

## OSS / distribution

- MIT license, GitHub. CONTRIBUTING.md keeps adapter PRs scoped to the interface.
- Install for colleagues = one line in their MCP client config:
  ```json
  "powerbi": { "command": "npx", "args": ["-y", "cloakroom", "--config", "masking.yaml", "--", "<original powerbi-mcp command>"] }
  ```
- The **leak test suite is the headline CI artifact**: fixture tool results containing seeded sensitive values; assert zero occurrences in any client-bound byte. Adapters must ship their own fixtures.
- Admin UI launched via `npx cloakroom ui`.

## Known limitations / open questions

- **Write operations:** the upstream server can modify the model. If the LLM writes a measure containing the literal `"Client 1"`, inbound unmasking would write the *real* name into the model — correct behaviour, but worth being deliberate about. Option: read-only mode flag that blocks write tools entirely.
- **Aggregate inference:** with numbers unmasked, someone who knows "the biggest client" could infer identity from revenue rank. Accepted trade-off per scope decision; numeric scaling can be added later as a per-column option.
- **Very high cardinality columns** (millions of customers): warm-up scan cost. Mitigation: lazy registration + scan caps, or sample-based warm-up with the global sweep as backstop.
- **Token churn:** if real names change upstream, old mappings persist (harmless) and new values get new tokens.

## Build milestones

1. **Repo scaffold + pass-through proxy** — monorepo (core/adapter-powerbi/ui/cli), MIT license, README with threat model, CI skeleton; mirror upstream tools verbatim; verify Claude works through it unchanged.
2. **Config + mapping store + warm-up scan** — YAML loader, JSONL store (sequential + HMAC modes), adapter-driven `VALUES()` scans.
3. **Outbound masking** — column-aware tokenizer (via adapter) + global sweep over all tool results and errors; leak test suite in CI.
4. **Inbound unmasking** — token detection/substitution in tool arguments; unknown-token errors.
5. **Admin UI** (done) — localhost web app: schema discovery, sensitivity triage, cardinality-driven mapping (manual grid < 50 distinct, auto strategy above), raw-vs-masked preview.
6. **Hardening + publish** — masked logging, read-only mode flag, high-cardinality handling, generic (no-adapter) mode docs, npm publish.

Each milestone is independently testable; milestone 1 alone proves the architecture with zero masking logic. Fabric adapter is post-v1 and should be ~one package.
