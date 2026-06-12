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
  loadConfig,
  type ColumnRule,
  type MaskConfig,
  type SourceAdapter,
  type ToolCaller,
} from "cloakroom-core";
import { PAGE_HTML } from "./page.js";

const UI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

const SUGGEST_RE =
  /(name|email|phone|mobile|address|contact|customer|client|company|trading|person|owner|supplier|vendor|account)/i;

export interface UiOptions {
  configPath: string;
  adapter: SourceAdapter;
  upstreamCommand: string;
  upstreamArgs: string[];
  /** 0 picks an ephemeral port. Default 7682. */
  port?: number;
  log?: (line: string) => void;
}

export interface UiHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * Localhost-only admin UI. It deliberately shows REAL sample values — the
 * human owner is allowed to see them; this server must never be exposed
 * beyond 127.0.0.1.
 */
export async function runUi(opts: UiOptions): Promise<UiHandle> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));
  let cfg: MaskConfig = loadConfig(opts.configPath);
  let matcher = new RuleMatcher(cfg.columns);
  const store = new MappingStore(cfg.mappingStore, {
    mode: cfg.tokenMode,
    hmacSecret: process.env[cfg.hmacSecretEnv],
  });

  const client = new Client({ name: "cloakroom-ui", version: UI_VERSION }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: opts.upstreamCommand,
      args: opts.upstreamArgs,
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );
  const call: ToolCaller = async (tool, args) => client.callTool({ name: tool, arguments: args });

  let prepareStatus = "";
  let currentModel: string | undefined = cfg.model;
  let connecting = false;
  const connectModel = async (model?: string): Promise<void> => {
    if (!opts.adapter.prepare) return;
    try {
      prepareStatus = (await opts.adapter.prepare(call, model)) || "ready";
      currentModel = model;
      log(`[cloakroom ui] ${prepareStatus}`);
    } catch (e) {
      prepareStatus = `NOT CONNECTED: ${e instanceof Error ? e.message : String(e)}`;
      log(`[cloakroom ui] ${prepareStatus}`);
    }
  };
  await connectModel(cfg.model);

  // Hand-edits to masking.yaml show up without restarting the UI server.
  let cfgMtime = safeMtime(opts.configPath);
  const maybeReloadCfg = (): void => {
    const m = safeMtime(opts.configPath);
    if (m !== 0 && m !== cfgMtime) {
      cfgMtime = m;
      try {
        cfg = loadConfig(opts.configPath);
        matcher = new RuleMatcher(cfg.columns);
        log("[cloakroom ui] masking.yaml reloaded");
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

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML.replace("__CLOAKROOM_VERSION__", UI_VERSION));
      return;
    }

    if (req.method === "GET" && path === "/api/state") {
      sendJson(res, 200, {
        configPath: opts.configPath,
        tokenMode: cfg.tokenMode,
        storeCount: store.count(),
        adapter: opts.adapter.name,
        connection: prepareStatus,
        rules: cfg.columns,
      });
      return;
    }

    if (req.method === "GET" && path === "/api/models") {
      const models = opts.adapter.listModels ? await opts.adapter.listModels(call) : [];
      // Auto-(re)connect: the UI may have started before any Power BI file
      // was open (or been reused by the ribbon button long after). The page
      // polls this endpoint every 15s, so a model that appears gets picked
      // up without a restart.
      if (models.length > 0 && prepareStatus.startsWith("NOT CONNECTED") && !connecting) {
        connecting = true;
        try {
          await connectModel(currentModel);
        } finally {
          connecting = false;
        }
      }
      sendJson(res, 200, { models, current: currentModel ?? models[0] ?? null, connection: prepareStatus });
      return;
    }

    if (req.method === "POST" && path === "/api/connect") {
      const body = (await readBody(req)) as { model?: string };
      await connectModel(body.model);
      const failed = prepareStatus.startsWith("NOT CONNECTED");
      sendJson(res, failed ? 502 : 200, { ok: !failed, connection: prepareStatus });
      return;
    }

    if (req.method === "GET" && path === "/api/columns") {
      if (!opts.adapter.listColumns) {
        sendJson(res, 400, { error: `adapter "${opts.adapter.name}" does not support schema discovery` });
        return;
      }
      const cols = await opts.adapter.listColumns(call);
      const dismissed = new Set((cfg.dismissed ?? []).map((d) => d.toLowerCase()));
      sendJson(
        res,
        200,
        cols.map((c) => {
          const keyStr = `${c.table}[${c.column}]`;
          const rule = matcher.matchKey(keyStr);
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
      if (!opts.adapter.columnSamples) {
        sendJson(res, 400, { error: "adapter does not support sampling" });
        return;
      }
      const limit = 50;
      const s = await opts.adapter.columnSamples(call, { table, column }, limit);
      const keyStr = `${table}[${column}]`;
      const rule = matcher.matchKey(keyStr);
      const values = s.values.map((v) => ({
        value: v,
        token: rule ? (store.lookupByValue(rule.groupId, v)?.token ?? null) : null,
      }));
      sendJson(res, 200, {
        key: keyStr,
        distinctCount: s.distinctCount,
        sampleLimit: limit,
        editable: s.distinctCount !== undefined && s.distinctCount <= limit,
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
      const raw = (parseYaml(readFileSync(opts.configPath, "utf8")) ?? {}) as Record<string, unknown>;
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
      writeFileSync(opts.configPath, stringifyYaml(raw));
      cfgMtime = safeMtime(opts.configPath);
      cfg = { ...cfg, ...ConfigSchema.partial().parse(raw), mappingStore: cfg.mappingStore };
      matcher = new RuleMatcher(cfg.columns);
      log(`[cloakroom ui] rules saved (${cfg.columns.length} rules)`);

      // Warm up the saved rule through the UI's OWN upstream connection so
      // every value is registered before the agent asks anything — without
      // disturbing the agent's connection (the proxy spawns its own server).
      // Mappings reach the proxy via the shared store within ~150ms.
      let warmup = "skipped";
      if (!body.remove && opts.adapter.warmupCall && opts.adapter.parseWarmupValues) {
        const compiled = compileRules(cfg.columns).find(
          (c) => c.rule.match.toLowerCase() === body.match!.toLowerCase(),
        );
        if (compiled?.concrete) {
          warmup = "started";
          const excludedLower = new Set((compiled.rule.exclude ?? []).map((v) => v.toLowerCase()));
          const warmupCallSpec = opts.adapter.warmupCall(compiled.concrete);
          if (warmupCallSpec) {
            void (async () => {
              try {
                const resUp = await call(warmupCallSpec.tool, warmupCallSpec.args);
                const values = opts.adapter.parseWarmupValues!(resUp, compiled.concrete!);
                let n = 0;
                for (const v of values) {
                  if (!v || excludedLower.has(v.toLowerCase())) continue;
                  store.getOrCreateToken(compiled.groupId, compiled.rule.prefix, compiled.rule.mask, v);
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
      sendJson(res, 200, { ok: true, rules: cfg.columns, warmup });
      return;
    }

    if (req.method === "POST" && path === "/api/dismiss") {
      const body = (await readBody(req)) as { key?: string; undo?: boolean };
      if (!body.key) {
        sendJson(res, 400, { error: "key is required" });
        return;
      }
      const raw = (parseYaml(readFileSync(opts.configPath, "utf8")) ?? {}) as Record<string, unknown>;
      let list = (Array.isArray(raw.dismissed) ? raw.dismissed : []).map(String);
      if (body.undo) list = list.filter((d) => d.toLowerCase() !== body.key!.toLowerCase());
      else if (!list.some((d) => d.toLowerCase() === body.key!.toLowerCase())) list.push(body.key);
      raw.dismissed = list;
      writeFileSync(opts.configPath, stringifyYaml(raw));
      cfgMtime = safeMtime(opts.configPath);
      cfg = { ...cfg, dismissed: list };
      sendJson(res, 200, { ok: true, dismissed: list });
      return;
    }

    if (req.method === "GET" && path === "/api/mappings-list") {
      // Full mapping table for the human owner: token, real value, column group.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 5000), 20000);
      const all = store.allMappings();
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
      const results = store
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
      const rule = body.match ? matcher.byMatchString(body.match) : undefined;
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
          store.assignToken(rule.groupId, rule.rule.prefix, a.value, a.token.trim());
        } else {
          store.getOrCreateToken(rule.groupId, rule.rule.prefix, rule.rule.mask, a.value);
        }
        applied++;
      }
      sendJson(res, 200, { ok: true, applied, storeCount: store.count() });
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
      await client.close();
    },
  };
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
