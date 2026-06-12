# cloakroom

**A masking proxy for MCP servers: sensitive customer data never reaches the AI agent's context.**

cloakroom sits between an AI agent (Claude, etc.) and a data-serving MCP server. Values from columns you tag as sensitive are replaced with stable, deterministic tokens — `"Contoso Ltd"` becomes `"Client 1"`, everywhere, every session. The agent still understands structure, grouping, and joins; it just never sees the real names. When the agent filters by `"Client 1"`, the proxy translates it back to the real value on the way in, so analysis works end to end.

Ships with an adapter for [powerbi-modeling-mcp](https://github.com/microsoft/powerbi-modeling-mcp). The core is server-agnostic — adapters for other data servers (Fabric, SQL, etc.) implement one small interface.

## Quickstart (Claude Desktop)

### Prerequisites

- **Node.js 20 or newer** — check with `node --version`. If you don't have it, install the LTS from [nodejs.org](https://nodejs.org/) (Windows: `winget install OpenJS.NodeJS.LTS` also works). The installer includes `npm` and `npx` and adds them to your PATH by default — keep that option selected, and open a **new** terminal afterwards so the PATH change takes effect. If `npx --version` isn't recognized in a fresh terminal, re-run the installer and make sure "Add to PATH" is ticked.
- **Claude Desktop with your Power BI MCP server already configured** (e.g. [powerbi-modeling-mcp](https://github.com/microsoft/powerbi-modeling-mcp)) — `setup` wraps the entry you already have; it doesn't install the upstream server.
- **Power BI Desktop** open with your model, for the admin UI and warm-up scans to connect to.

### Setup

You never need to know the server command — the Claude app launches MCP servers, and `setup` rewires its config for you:

```bash
npx cloakroom setup           # wraps your Power BI server entry (backup kept)
# restart Claude Desktop, then:
npx cloakroom ui              # pick which columns to mask, assign tokens
```

`setup` finds `claude_desktop_config.json` automatically (use `--server <name>` if you have several servers, `--claude-config <path>` if yours lives elsewhere, `npx cloakroom unwrap` to undo).

<details>
<summary>Manual setup (any MCP client)</summary>

Wrap your existing MCP server command in your client's config:

```json
"powerbi": {
  "command": "npx",
  "args": ["-y", "cloakroom", "--config", "/path/to/masking.yaml", "--",
           "<original powerbi-modeling-mcp command>", "<its args...>"]
}
```
</details>

That's it — one `npx cloakroom setup` per colleague.

## How it works

```
AI agent ⇄ cloakroom proxy ⇄ powerbi-modeling-mcp ⇄ your data
              │
              ├─ outbound: tag-aware tokenization + global sweep over ALL
              │  tool results, schemas, statistics, and error messages
              ├─ inbound: tokens in queries/filters translated back to real
              │  values (unknown tokens fail closed)
              └─ local JSONL mapping store (never leaves your machine)
```

- **Warm-up scan**: at startup the proxy enumerates each tagged column (`EVALUATE VALUES(...)`) inside the proxy process, so every sensitive value is known *before* the agent asks anything. After that, the global sweep catches those values anywhere they appear — including embedded in DAX/M expressions and error messages.
- **Token modes**: `sequential` gives friendly names ("Client 1"); `hmac` derives tokens from a shared team secret so every colleague sees identical tokens with nothing to sync.
- **Read-only mode**: optionally block all model-mutating operations.

## Configuration

```yaml
mappingStore: ./masking-map.jsonl    # local only; this file IS the secret
tokenMode: sequential                # or hmac (+ set MASK_TEAM_SECRET)
warmup: true
readOnly: false

columns:
  - match: "Customer[Customer Name]"
    mask: token
    prefix: Client
    exclude: ["UNKNOWN", "N/A"]       # placeholders that must pass through unmasked
  - match: "Customer[Email]"
    mask: email                       # → client1@masked.example
    prefix: Client
    linkTo: "Customer[Customer Name]" # same entity → same number
  - match: "*[*Phone*]"               # wildcards OK (no warm-up scan)
    mask: token
    prefix: Phone
```

## What the agent sees

Nothing to set up, nothing to learn. The proxy is invisible: same tools, same schemas, same workflow. Two affordances keep agents oriented:

- Every mirrored tool description carries a short note that values like "Client 1" are **stable pseudonyms** to be used verbatim in filters.
- A synthetic `masking_info` tool lets the agent discover which column patterns are masked and how tokens behave (patterns only — never values).

Unknown tokens fail closed with an instructive error, so an agent that invents "Client 99" gets corrected instead of silently querying nothing.

## Admin UI

```bash
npx cloakroom ui      # discovers your server via Claude Desktop's config
```

Opens a localhost-only page that connects to your model: search and browse tables/columns (likely-sensitive ones are flagged), see distinct counts and real sample values, and save masking rules straight into `masking.yaml`. A **mask all text** button on each table covers every untagged text column in one click; columns you mark **Not sensitive** get a *skipped* badge and can be restored at any time. Every sampled value shows a live **"agent sees"** preview — its token, "auto-token on first query", or "(excluded)". Assign meaningful-but-safe tokens by hand ("BigRetailer"), leave blank for automatic numbering, or tick **skip** to exclude placeholders like "UNKNOWN" from masking entirely. High-cardinality columns show the first 50 values; the rest are tokenized automatically. Wrongly flagged columns get a **Not sensitive** button that dismisses the suggestion for good. A **token decoder** in the header searches both directions — type "Company 5" to see who it really is, or a real name to find its token — so you can cross-reference anything the agent tells you. The page shows real data by design: it is for the human data owner and binds to 127.0.0.1 only.

## Where data lives — and how durable it is

cloakroom persists exactly two files, both local, both under your control. There is no cloud component and no telemetry.

| File | Contains | Sensitivity |
|---|---|---|
| `masking.yaml` | rules: column patterns, prefixes, exclude lists, dismissed suggestions | low — no customer data beyond excluded placeholder values |
| `masking-map.jsonl` (path set by `mappingStore:`, resolved relative to masking.yaml) | the value↔token map — **real values** | high — treat like a credential; created with owner-only permissions |

**Durability.** Mappings are appended synchronously: a token is on disk before the masked response that uses it is returned, so a process crash cannot orphan a token, and a torn final line is tolerated on load. The proxy and admin UI can safely share the file at the same time (each picks up the other's appends).

**If the mapping file is lost**, no data leaks — but token stability breaks, and the consequence depends on `tokenMode`:

- `sequential`: numbering follows discovery order, so a regenerated store may assign "Client 5" to a *different* client than your old conversations refer to. Back the file up (privately) if long-term cross-referencing matters.
- `hmac`: the store is just a cache. Tokens derive from the team secret, so identical tokens regenerate from scratch — nothing to back up except the secret itself.

## Threat model — read this before relying on it

**What cloakroom protects against:** accidental exposure of tagged sensitive values to the AI agent — in query results, metadata, expressions, statistics, and error messages — for any value the proxy has seen in a tagged column or warm-up scan.

**What it does NOT protect against:**

- Values never observed in a tagged column (warm-up scans mitigate this, but e.g. a brand-new value appearing only inside an expression before any scan would pass through).
- Inference from unmasked data — if revenue is unmasked, "the biggest client" may be guessable.
- Numbers and dates (by design, v1 masks text identifiers only).
- A malicious upstream server, a compromised machine, or anyone with access to the mapping store file.
- Side channels outside the MCP transport. Notably, powerbi-modeling-mcp writes raw query results to local temp CSV files (`%LOCALAPPDATA%\Temp\PowerBIModelingMCP\QueryResults\`). The proxy redacts those file paths from results and masks the upstream server's log output, but the files themselves remain on disk — if your agent also has filesystem access, restrict it or clean that directory.

cloakroom is a **guardrail against accidental exposure, not a DLP product or security boundary**. Treat the mapping store (`masking-map.jsonl`) like a credential: gitignored (the default), local, backed up only somewhere private.

## Packages

| Package | What it is |
|---|---|
| `cloakroom` | CLI — wires everything together |
| `cloakroom-core` | server-agnostic pipeline: store, sweep, proxy |
| `cloakroom-adapter-powerbi` | Power BI semantic-model adapter |
| `cloakroom-ui` | localhost admin UI (triage, mapping grid) |

Generic mode (`--adapter none`) works against any MCP server: no column discovery or warm-up, global sweep only, mappings seeded externally.

## Development

```bash
npm install
npm test     # builds + unit tests, e2e leak tests, and a jsdom browser test
```

Node >= 20. No native dependencies. The headline test is the **leak test**: an
end-to-end run against a fake upstream server asserting that no seeded
sensitive value ever appears in any byte the client receives.

MIT licensed. Adapter contributions welcome — implement `SourceAdapter` from
`cloakroom-core` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
