import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ConfigSchema,
  MappingStore,
  RuleMatcher,
  compileRules,
  formatToken,
  loadConfig,
  type ColumnRule,
  type MaskConfig,
  type SourceAdapter,
  type ToolCaller,
} from "cloakroom-core";
import { CLOAKROOM_ICON_DATA_URI } from "./icon.js";
import { PAGE_HTML } from "./page.js";

export { CLOAKROOM_ICON_DATA_URI } from "./icon.js";

const UI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

const SUGGEST_RE =
  /(name|email|phone|mobile|address|contact|customer|client|company|trading|person|owner|supplier|vendor|account)/i;

/** Connection status shown for sources without an adapter. */
const GENERIC_STATUS =
  "sweep-only (generic mode: known values are masked everywhere; no column discovery or warm-up)";

/** One masked MCP server the UI can manage. */
export interface UiSource {
  /** Server name from the MCP client config (or a label in explicit mode). */
  name: string;
  /** Adapter instance; undefined = generic mode (sweep-only, no discovery). */
  adapter?: SourceAdapter;
  /** Adapter name for display ("powerbi", "none"). */
  adapterName: string;
  /** masking.yaml this source was wrapped with. */
  configPath: string;
  upstreamCommand: string;
  upstreamArgs: string[];
}

export interface UiOptions {
  /**
   * Every masked server the UI should manage. Sources with an adapter get
   * schema discovery and warm-up; generic sources get a coverage summary and
   * never spawn their upstream.
   */
  sources?: UiSource[];
  /** Initially selected source name; defaults to the first with an adapter. */
  initialSource?: string;
  /** Single-source mode (tests and the explicit `-- <command>` CLI form). */
  configPath?: string;
  adapter?: SourceAdapter;
  upstreamCommand?: string;
  upstreamArgs?: string[];
  /** 0 picks an ephemeral port. Default 7682. */
  port?: number;
  log?: (line: string) => void;
}

export interface UiHandle {
  url: string;
  close(): Promise<void>;
}

/** Live state for one source: its config, store, and (lazy) upstream link. */
interface SourceSession {
  spec: UiSource;
  cfg: MaskConfig;
  cfgMtime: number;
  matcher: RuleMatcher;
  store: MappingStore;
  client?: Client;
  call?: ToolCaller;
  prepareStatus: string;
  currentModel?: string;
  connecting: boolean;
}

/**
 * Localhost-only admin UI. It deliberately shows REAL sample values — the
 * human owner is allowed to see them; this server must never be exposed
 * beyond 127.0.0.1.
 *
 * Multi-source model: masking RULES, discovery, and triage are per source;
 * the mapping STORE is shared wherever sources point at the same file, so
 * one entity keeps one token across every connection.
 */
export async function runUi(opts: UiOptions): Promise<UiHandle> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));

  const specs: UiSource[] =
    opts.sources && opts.sources.length > 0
      ? opts.sources
      : [
          {
            name: "upstream",
            adapter: opts.adapter,
            adapterName: opts.adapter?.name ?? "none",
            configPath: opts.configPath!,
            upstreamCommand: opts.upstreamCommand!,
            upstreamArgs: opts.upstreamArgs ?? [],
          },
        ];

  // Stores are shared by mapping-store path: same file -> same instance ->
  // same tokens across sources. This is the invariant the UI presents.
  const storeByPath = new Map<string, MappingStore>();
  const sessions = new Map<string, SourceSession>();

  function getSession(name: string): SourceSession {
    const existing = sessions.get(name);
    if (existing) return existing;
    const spec = specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown source "${name}"`);
    const cfg = loadConfig(spec.configPath);
    let store = storeByPath.get(cfg.mappingStore);
    if (!store) {
      store = new MappingStore(cfg.mappingStore, {
        mode: cfg.tokenMode,
        hmacSecret: process.env[cfg.hmacSecretEnv],
      });
      storeByPath.set(cfg.mappingStore, store);
    }
    const session: SourceSession = {
      spec,
      cfg,
      cfgMtime: safeMtime(spec.configPath),
      matcher: new RuleMatcher(cfg.columns),
      store,
      prepareStatus: spec.adapter ? "" : GENERIC_STATUS,
      currentModel: cfg.model,
      connecting: false,
    };
    sessions.set(name, session);
    return session;
  }

  async function connectModel(s: SourceSession, model?: string): Promise<void> {
    if (!s.spec.adapter?.prepare || !s.call) return;
    try {
      s.prepareStatus = (await s.spec.adapter.prepare(s.call, model)) || "ready";
      s.currentModel = model;
      log(`[cloakroom ui] ${s.spec.name}: ${s.prepareStatus}`);
    } catch (e) {
      s.prepareStatus = `NOT CONNECTED: ${e instanceof Error ? e.message : String(e)}`;
      log(`[cloakroom ui] ${s.spec.name}: ${s.prepareStatus}`);
    }
  }

  /** Spawn + connect the upstream, once. Generic sources never spawn. */
  async function ensureConnected(s: SourceSession): Promise<void> {
    if (!s.spec.adapter || s.client) return;
    const client = new Client({ name: "cloakroom-ui", version: UI_VERSION }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: s.spec.upstreamCommand,
        args: s.spec.upstreamArgs,
        env: process.env as Record<string, string>,
        stderr: "inherit",
      }),
    );
    s.client = client;
    s.call = async (tool, args) => client.callTool({ name: tool, arguments: args });
    await connectModel(s, s.cfg.model);
  }

  const initialName =
    (opts.initialSource && specs.some((s) => s.name === opts.initialSource) && opts.initialSource) ||
    specs.find((s) => s.adapter)?.name ||
    specs[0].name;
  let current = getSession(initialName);
  await ensureConnected(current);

  // Hand-edits to the selected source's masking.yaml show up without a restart.
  const maybeReloadCfg = (): void => {
    const s = current;
    const m = safeMtime(s.spec.configPath);
    if (m !== 0 && m !== s.cfgMtime) {
      s.cfgMtime = m;
      try {
        s.cfg = loadConfig(s.spec.configPath);
        s.matcher = new RuleMatcher(s.cfg.columns);
        log(`[cloakroom ui] masking.yaml reloaded (${s.spec.name})`);
      } catch (e) {
        log(`[cloakroom ui] reload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const server = createServer((req, res) => {
    maybeReloadCfg();
    handle(req, res).catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // Defence in depth for a localhost server: reject DNS-rebinding hosts and
    // cross-origin POSTs (custom header forces a CORS preflight we never answer).
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    if (req.method === "POST" && req.headers["x-cloakroom"] !== "1") {
      sendJson(res, 403, { error: "missing x-cloakroom header" });
      return;
    }

    const s = current;
    const adapter = s.spec.adapter;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        PAGE_HTML.replace("__CLOAKROOM_VERSION__", UI_VERSION).replaceAll(
          "__CLOAKROOM_ICON__",
          CLOAKROOM_ICON_DATA_URI,
        ),
      );
      return;
    }

    if (req.method === "GET" && path === "/api/state") {
      sendJson(res, 200, {
        source: s.spec.name,
        adapter: s.spec.adapterName,
        generic: !adapter,
        sourceCount: specs.length,
        configPath: s.spec.configPath,
        tokenMode: s.cfg.tokenMode,
        storeCount: s.store.count(),
        connection: s.prepareStatus,
        rules: s.cfg.columns,
      });
      return;
    }

    if (req.method === "GET" && path === "/api/sources") {
      sendJson(res, 200, {
        current: s.spec.name,
        sources: specs.map((spec) => {
          const sess = getSession(spec.name);
          return {
            name: spec.name,
            adapter: spec.adapterName,
            generic: !spec.adapter,
            connected: !!sess.client,
            ruleCount: sess.cfg.columns.length,
            configPath: spec.configPath,
          };
        }),
      });
      return;
    }

    if (req.method === "POST" && path === "/api/source") {
      const body = (await readBody(req)) as { name?: string };
      if (!body.name || !specs.some((sp) => sp.name === body.name)) {
        sendJson(res, 400, { error: `unknown source "${body.name ?? ""}"` });
        return;
      }
      const next = getSession(body.name);
      try {
        await ensureConnected(next);
      } catch (e) {
        sendJson(res, 502, {
          error: `could not start upstream for "${body.name}": ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      current = next;
      log(`[cloakroom ui] switched to source "${body.name}"`);
      sendJson(res, 200, {
        ok: true,
        name: next.spec.name,
        adapter: next.spec.adapterName,
        generic: !next.spec.adapter,
        connection: next.prepareStatus,
      });
      return;
    }

    if (req.method === "GET" && path === "/api/models") {
      const models = adapter?.listModels ? await adapter.listModels(s.call!) : [];
      // Auto-(re)connect: the UI may have started before any Power BI file
      // was open (or been reused by the ribbon button long after). The page
      // polls this endpoint every 15s, so a model that appears gets picked
      // up without a restart.
      if (models.length > 0 && s.prepareStatus.startsWith("NOT CONNECTED") && !s.connecting) {
        s.connecting = true;
        try {
          await connectModel(s, s.currentModel);
        } finally {
          s.connecting = false;
        }
      }
      sendJson(res, 200, { models, current: s.currentModel ?? models[0] ?? null, connection: s.prepareStatus });
      return;
    }

    if (req.method === "POST" && path === "/api/connect") {
      const body = (await readBody(req)) as { model?: string };
      await connectModel(s, body.model);
      const failed = s.prepareStatus.startsWith("NOT CONNECTED");
      sendJson(res, failed ? 502 : 200, { ok: !failed, connection: s.prepareStatus });
      return;
    }

    if (req.method === "GET" && path === "/api/columns") {
      if (!adapter?.listColumns) {
        sendJson(res, 400, { error: `source "${s.spec.name}" has no schema discovery (generic mode)` });
        return;
      }
      const cols = await adapter.listColumns(s.call!);
      const dismissed = new Set((s.cfg.dismissed ?? []).map((d) => d.toLowerCase()));
      sendJson(
        res,
        200,
        cols.map((c) => {
          const keyStr = `${c.table}[${c.column}]`;
          const rule = s.matcher.matchKey(keyStr);
          const isDismissed = dismissed.has(keyStr.toLowerCase());
          return {
            ...c,
            key: keyStr,
            tagged: rule ? rule.rule.match : null,
            dismissed: isDismissed,
            suggested:
              !rule &&
              !isDismissed &&
              (c.dataType === undefined || c.dataType === "String") &&
              SUGGEST_RE.test(c.column),
          };
        }),
      );
      return;
    }

    if (req.method === "GET" && path === "/api/column") {
      const table = url.searchParams.get("table") ?? "";
      const column = url.searchParams.get("column") ?? "";
      if (!table || !column) {
        sendJson(res, 400, { error: "table and column are required" });
        return;
      }
      if (!adapter?.columnSamples) {
        sendJson(res, 400, { error: "adapter does not support sampling" });
        return;
      }
      const limit = 50;
      const samples = await adapter.columnSamples(s.call!, { table, column }, limit);
      const keyStr = `${table}[${column}]`;
      const rule = s.matcher.matchKey(keyStr);
      const values = samples.values.map((v) => ({
        value: v,
        token: rule ? (s.store.lookupByValue(rule.groupId, v)?.token ?? null) : null,
      }));
      sendJson(res, 200, {
        key: keyStr,
        distinctCount: samples.distinctCount,
        sampleLimit: limit,
        editable: samples.distinctCount !== undefined && samples.distinctCount <= limit,
        rule: rule ? rule.rule : null,
        values,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/rule") {
      const body = (await readBody(req)) as Partial<ColumnRule> & { remove?: boolean };
      if (!body.match) {
        sendJson(res, 400, { error: "match is required" });
        return;
      }
      const raw = (parseYaml(readFileSync(s.spec.configPath, "utf8")) ?? {}) as Record<string, unknown>;
      const list = Array.isArray(raw.columns) ? (raw.columns as ColumnRule[]) : [];
      const idx = list.findIndex((r) => r.match === body.match);
      if (body.remove) {
        if (idx >= 0) list.splice(idx, 1);
      } else {
        const exclude = (Array.isArray(body.exclude) ? body.exclude : [])
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0);
        const rule: ColumnRule = {
          match: body.match,
          mask: body.mask ?? "token",
          prefix: body.prefix || "Value",
          ...(body.linkTo ? { linkTo: body.linkTo } : {}),
          exclude,
        };
        if (idx >= 0) list[idx] = rule;
        else list.push(rule);
      }
      raw.columns = list;
      writeFileSync(s.spec.configPath, stringifyYaml(raw));
      s.cfgMtime = safeMtime(s.spec.configPath);
      s.cfg = { ...s.cfg, ...ConfigSchema.partial().parse(raw), mappingStore: s.cfg.mappingStore };
      s.matcher = new RuleMatcher(s.cfg.columns);
      log(`[cloakroom ui] rules saved (${s.cfg.columns.length} rules, ${s.spec.name})`);

      // Warm up the saved rule through the UI's OWN upstream connection so
      // every value is registered before the agent asks anything — without
      // disturbing the agent's connection (the proxy spawns its own server).
      // Mappings reach the proxy via the shared store within ~150ms.
      let warmup = "skipped";
      if (!body.remove && adapter?.warmupCall && adapter.parseWarmupValues) {
        const compiled = compileRules(s.cfg.columns).find(
          (c) => c.rule.match.toLowerCase() === body.match!.toLowerCase(),
        );
        if (compiled?.concrete) {
          warmup = "started";
          const excludedLower = new Set((compiled.rule.exclude ?? []).map((v) => v.toLowerCase()));
          const warmupCallSpec = adapter.warmupCall(compiled.concrete);
          if (warmupCallSpec) {
            void (async () => {
              try {
                const resUp = await s.call!(warmupCallSpec.tool, warmupCallSpec.args);
                const values = adapter.parseWarmupValues!(resUp, compiled.concrete!);
                let n = 0;
                for (const v of values) {
                  if (!v || excludedLower.has(v.toLowerCase())) continue;
                  s.store.getOrCreateToken(compiled.groupId, compiled.rule.prefix, compiled.rule.mask, v);
                  n++;
                }
                log(`[cloakroom ui] warm-up ${compiled.rule.match}: ${n} values registered`);
              } catch (e) {
                log(`[cloakroom ui] warm-up failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            })();
          }
        }
      }
      sendJson(res, 200, { ok: true, rules: s.cfg.columns, warmup });
      return;
    }

    if (req.method === "POST" && path === "/api/dismiss") {
      const body = (await readBody(req)) as { key?: string; undo?: boolean };
      if (!body.key) {
        sendJson(res, 400, { error: "key is required" });
        return;
      }
      const raw = (parseYaml(readFileSync(s.spec.configPath, "utf8")) ?? {}) as Record<string, unknown>;
      let list = (Array.isArray(raw.dismissed) ? raw.dismissed : []).map(String);
      if (body.undo) list = list.filter((d) => d.toLowerCase() !== body.key!.toLowerCase());
      else if (!list.some((d) => d.toLowerCase() === body.key!.toLowerCase())) list.push(body.key);
      raw.dismissed = list;
      writeFileSync(s.spec.configPath, stringifyYaml(raw));
      s.cfgMtime = safeMtime(s.spec.configPath);
      s.cfg = { ...s.cfg, dismissed: list };
      sendJson(res, 200, { ok: true, dismissed: list });
      return;
    }

    if (req.method === "POST" && path === "/api/retoken") {
      // Rename existing sequential tokens after a prefix change, preserving
      // numbers ("Client 5" -> "Customer 5"). Custom tokens are never touched.
      // The store keeps old names unmasking (newest assignment wins for
      // masking; older tokens still translate inbound).
      const body = (await readBody(req)) as { match?: string; fromPrefix?: string };
      if (!body.match || !body.fromPrefix) {
        sendJson(res, 400, { error: "match and fromPrefix are required" });
        return;
      }
      const rule = s.matcher.byMatchString(body.match);
      if (!rule) {
        sendJson(res, 400, { error: "no rule found for match — save the rule first" });
        return;
      }
      if (s.cfg.tokenMode === "hmac") {
        sendJson(res, 400, { error: "re-tokening applies to sequential mode only (hmac tokens derive from the value)" });
        return;
      }
      const mask = rule.rule.mask;
      const toPrefix = rule.rule.prefix;
      const oldRe =
        mask === "email"
          ? new RegExp(`^${escapeRegex(body.fromPrefix.toLowerCase())}(\\d+)@masked\\.example$`)
          : new RegExp(`^${escapeRegex(body.fromPrefix)} (\\d+)$`);
      let renamed = 0;
      let kept = 0;
      let conflicts = 0;
      for (const m of s.store.allMappings()) {
        if (m.group !== rule.groupId) continue;
        const hit = oldRe.exec(m.token);
        if (!hit) {
          kept++; // custom token — never renamed
          continue;
        }
        const newToken = formatToken(toPrefix, mask, Number(hit[1]));
        if (newToken === m.token) continue;
        try {
          s.store.assignToken(rule.groupId, toPrefix, m.value, newToken);
          renamed++;
        } catch {
          conflicts++; // target token taken by another value — keep the old one
        }
      }
      log(`[cloakroom ui] re-token ${rule.rule.match}: ${renamed} renamed, ${kept} custom kept, ${conflicts} conflicts`);
      sendJson(res, 200, { ok: true, renamed, kept, conflicts });
      return;
    }

    if (req.method === "GET" && path === "/api/mappings-list") {
      // Full mapping table for the human owner: token, real value, column group.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 5000), 20000);
      const all = s.store.allMappings();
      sendJson(res, 200, { total: all.length, mappings: all.slice(0, limit) });
      return;
    }

    if (req.method === "GET" && path === "/api/lookup") {
      // Human-facing decoder: search tokens AND real values, both directions.
      // Localhost only — this intentionally reveals real values to the owner.
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (!q) {
        sendJson(res, 200, []);
        return;
      }
      const results = s.store
        .allMappings()
        .filter((m) => m.token.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
        .slice(0, 25);
      sendJson(res, 200, results);
      return;
    }

    if (req.method === "POST" && path === "/api/mappings") {
      const body = (await readBody(req)) as {
        match?: string;
        assignments?: { value: string; token?: string }[];
      };
      const rule = body.match ? s.matcher.byMatchString(body.match) : undefined;
      if (!rule) {
        sendJson(res, 400, { error: "no rule found for match — save the rule first" });
        return;
      }
      const excludedLower = new Set((rule.rule.exclude ?? []).map((v) => v.toLowerCase()));
      let applied = 0;
      for (const a of body.assignments ?? []) {
        if (!a.value) continue;
        if (excludedLower.has(a.value.toLowerCase())) continue;
        if (a.token && a.token.trim().length > 0) {
          s.store.assignToken(rule.groupId, rule.rule.prefix, a.value, a.token.trim());
        } else {
          s.store.getOrCreateToken(rule.groupId, rule.rule.prefix, rule.rule.mask, a.value);
        }
        applied++;
      }
      sendJson(res, 200, { ok: true, applied, storeCount: s.store.count() });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const port = opts.port ?? 7682;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const uiUrl = `http://127.0.0.1:${actualPort}`;
  log(`[cloakroom ui] ready at ${uiUrl} (localhost only — shows real sample values)`);
  return {
    url: uiUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const sess of sessions.values()) {
        if (sess.client) await sess.client.close();
      }
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
