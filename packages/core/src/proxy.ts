import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import type { SourceAdapter } from "./adapter.js";
import { loadConfig, type MaskConfig } from "./config.js";
import { MaskingPipeline, UnknownTokenError, type TokenRename } from "./pipeline.js";
import { MappingStore } from "./store.js";

/** Version of the running package — single source of truth is package.json. */
export const CLOAKROOM_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export interface ProxyOptions {
  config: MaskConfig;
  /** Path to masking.yaml — enables hot-reload of rules saved by the admin UI. */
  configPath?: string;
  adapter?: SourceAdapter;
  upstreamCommand: string;
  upstreamArgs: string[];
  /** Masked logger; defaults to stderr. */
  log?: (line: string) => void;
}

export async function runProxy(opts: ProxyOptions): Promise<void> {
  let { config } = opts;
  const { adapter } = opts;

  const secret = process.env[config.hmacSecretEnv];
  if (config.tokenMode === "hmac" && !secret) {
    throw new Error(
      `tokenMode is "hmac" but environment variable ${config.hmacSecretEnv} is not set`,
    );
  }
  const store = new MappingStore(config.mappingStore, {
    mode: config.tokenMode,
    hmacSecret: secret,
  });
  const pipeline = new MaskingPipeline(config, store, adapter);

  const rawLog = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const log = (line: string) => rawLog(pipeline.maskText(line));

  // ---- upstream (real server) ----
  const client = new Client({ name: "cloakroom-proxy", version: CLOAKROOM_VERSION }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: opts.upstreamCommand,
    args: opts.upstreamArgs,
    env: process.env as Record<string, string>,
    stderr: "pipe", // upstream logs can echo data values — sweep them too
  });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(pipeline.maskText(chunk.toString("utf8")));
  });
  log(`[cloakroom] connected upstream: ${opts.upstreamCommand}`);

  // ---- session preparation (e.g. connect to Power BI Desktop) ----
  const callUp = async (tool: string, args: Record<string, unknown>) =>
    client.callTool({ name: tool, arguments: args });

  const runWarmup = async (label: string): Promise<void> => {
    if (!config.warmup || !adapter?.warmupCall || !adapter.parseWarmupValues) return;
    for (const rule of pipeline.warmupRules()) {
      const call = adapter.warmupCall(rule.concrete!);
      if (!call) continue;
      try {
        const res = await client.callTool({ name: call.tool, arguments: call.args });
        const values = adapter.parseWarmupValues(res, rule.concrete!);
        pipeline.registerWarmupValues(rule, values);
        if (values.length > 0) {
          log(`[cloakroom] warm-up ${rule.rule.match}${label}: ${values.length} values registered`);
        }
      } catch (e) {
        log(`[cloakroom] warm-up skipped for ${rule.rule.match}${label}: ${errMsg(e)}`);
      }
    }
  };

  if (adapter?.prepare) {
    try {
      // With several models open and no pinned `model:`, warm up tagged
      // columns across ALL of them so values are protected regardless of
      // which model the agent later switches to.
      let models: string[] = [];
      if (!config.model && adapter.listModels) {
        models = await adapter.listModels(callUp);
      }
      if (models.length > 1) {
        for (const m of models) {
          try {
            await adapter.prepare(callUp, m);
            await runWarmup(` [${m}]`);
          } catch (e) {
            log(`[cloakroom] could not warm up model "${m}": ${errMsg(e)}`);
          }
        }
        // Leave the first model as the active connection.
        const status = await adapter.prepare(callUp, models[0]);
        if (status) log(`[cloakroom] ${status}`);
      } else {
        const status = await adapter.prepare(callUp, config.model);
        if (status) log(`[cloakroom] ${status}`);
        await runWarmup("");
      }
    } catch (e) {
      log(`[cloakroom] prepare failed: ${errMsg(e)} (warm-up may be skipped)`);
    }
  } else {
    await runWarmup("");
  }
  log(`[cloakroom] mapping store ready (${store.count()} mappings)`);

  // ---- downstream (the agent's view) ----
  // Mirror the upstream capability set so prompts/resources (e.g. the Power
  // BI server's DAX guidance docs) survive the proxy — masked like all else.
  const upstreamCaps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name: "cloakroom", version: CLOAKROOM_VERSION },
    {
      capabilities: {
        tools: {},
        ...(upstreamCaps.prompts ? { prompts: {} } : {}),
        ...(upstreamCaps.resources ? { resources: {} } : {}),
      },
    },
  );

  if (upstreamCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () =>
      pipeline.maskResult("prompts/list", await client.listPrompts()),
    );
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const promptArgs = pipeline.unmaskArgs(req.params.arguments ?? {});
      return pipeline.maskResult(
        "prompts/get",
        await client.getPrompt({ name: req.params.name, arguments: promptArgs }),
      );
    });
  }

  if (upstreamCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () =>
      pipeline.maskResult("resources/list", await client.listResources()),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      try {
        return pipeline.maskResult("resources/templates", await client.listResourceTemplates());
      } catch {
        return { resourceTemplates: [] };
      }
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      // Never let the agent read local files through the proxy — the upstream
      // server writes RAW query results to temp files, and a file:// read
      // would bypass masking entirely.
      if (/^file:/i.test(req.params.uri.trim())) {
        throw new Error("cloakroom: file:// resources are blocked; use the masked tool results instead");
      }
      return pipeline.maskResult("resources/read", await client.readResource({ uri: req.params.uri }));
    });
  }

  const TOKEN_NOTE =
    "\n\nNote (cloakroom): sensitive values in results are pseudonymized with stable tokens " +
    'such as "Client 1". Tokens are consistent across queries and sessions — treat them as ' +
    "real identifiers and use them verbatim in filters/queries. Call the masking_info tool " +
    "for details of what is masked.";

  const maskingInfoTool = {
    name: "masking_info",
    description:
      "Describes the data-masking layer protecting this server: which column patterns are " +
      "pseudonymized and how tokens behave. Masking is transparent — query normally and use " +
      "tokens verbatim as identifiers.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstream = await client.listTools();
    const tools = upstream.tools.map((t) => ({
      ...t,
      description: (t.description ?? "") + TOKEN_NOTE,
    }));
    if (!tools.some((t) => t.name === maskingInfoTool.name)) tools.push(maskingInfoTool);
    // Descriptions/schemas could embed sample values — sweep them too.
    return pipeline.maskResult("tools/list", { ...upstream, tools });
  });

  // ---- hot-reload of masking.yaml (rules saved in the admin UI apply live) ----
  let lastConfigCheck = 0;
  let lastConfigMtime = opts.configPath ? safeMtime(opts.configPath) : 0;
  const maybeReloadConfig = (): void => {
    if (!opts.configPath) return;
    const now = Date.now();
    if (now - lastConfigCheck < 1500) return;
    lastConfigCheck = now;
    const mtime = safeMtime(opts.configPath);
    if (mtime === 0 || mtime === lastConfigMtime) return;
    lastConfigMtime = mtime;
    try {
      config = loadConfig(opts.configPath);
      pipeline.updateConfig(config);
      log(`[cloakroom] masking.yaml reloaded (${config.columns.length} rules)`);
      // Newly tagged columns need their values registered — fire warm-up in
      // the background; the sweep picks results up as they land.
      void runWarmup(" [reload]").catch(() => {});
    } catch (e) {
      log(`[cloakroom] masking.yaml reload failed: ${errMsg(e)} (keeping previous rules)`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    maybeReloadConfig();
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    if (name === "masking_info") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                maskingActive: true,
                adapter: adapter?.name ?? "none",
                tokenMode: config.tokenMode,
                readOnly: config.readOnly,
                maskedColumns: config.columns.map((c) => ({
                  match: c.match,
                  mask: c.mask,
                  tokenFormat:
                    config.tokenMode === "hmac"
                      ? `${c.prefix}_<hash>`
                      : c.mask === "email"
                        ? `${c.prefix.toLowerCase()}<n>@masked.example`
                        : `${c.prefix} <n>`,
                })),
                guidance: [
                  "Tokens are stable pseudonyms: the same token always refers to the same real entity, across queries and sessions.",
                  "Use tokens verbatim in DAX filters and tool arguments; the proxy translates them to real values upstream.",
                  "Never guess tokens — only use tokens that appeared in earlier results. Unknown tokens are rejected.",
                  "Aggregations, grouping and joins work normally; only the display values are pseudonymized.",
                  "Sorting by a masked column orders by the REAL value, so tokens may appear out of sequence — that is expected, not an error.",
                  "Substring/partial-text matching on masked columns (SEARCH, CONTAINSSTRING, 'starts with') will not work — filter by exact tokens, or ask the user to identify the entity via their local decoder.",
                ],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (pipeline.isWriteCall(name, args)) {
      return errorResult(`cloakroom is running in read-only mode; "${name}" write operations are blocked.`);
    }

    let realArgs: Record<string, unknown>;
    let renames: TokenRename[] = [];
    try {
      const tracked = pipeline.unmaskArgsTracked(args);
      realArgs = tracked.args;
      renames = tracked.renames;
    } catch (e) {
      if (e instanceof UnknownTokenError) return errorResult(e.message);
      throw e;
    }

    try {
      const result = await client.callTool({ name, arguments: realArgs });
      const masked = redactFileUris(pipeline.maskResult(name, result));
      // The agent used a token that has since been renamed by the data
      // owner. It still translated correctly, but results now show the new
      // name — tell the agent so the mismatch doesn't read as an error.
      if (renames.length > 0) {
        const m = masked as { content?: unknown[] };
        if (Array.isArray(m.content)) {
          const list = renames.map((r) => `"${r.from}" is now "${r.to}"`).join("; ");
          m.content.push({
            type: "text" as const,
            text:
              `[cloakroom] Token rename notice: ${list}. ` +
              `Your filter was applied correctly (old names still translate), but results display the new name. ` +
              `Use the new name in future filters and when reporting to the user.`,
          });
        }
      }
      return masked;
    } catch (e) {
      // Upstream errors can echo filter values — mask before forwarding.
      return errorResult(pipeline.maskText(errMsg(e)));
    }
  });

  await server.connect(new StdioServerTransport());
  log("[cloakroom] proxy ready");
}

/**
 * Strip local file paths from resource blocks. The upstream server saves raw
 * results to temp files and references them by path — the embedded (masked)
 * text is what the agent should use, not the unmasked file on disk.
 */
function redactFileUris<T>(result: T): T {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const resource = (block as { resource?: { uri?: unknown } }).resource;
      if (resource && typeof resource.uri === "string" && resource.uri.startsWith("file:")) {
        resource.uri = "file:///masked/query-result";
      }
    }
  }
  return result;
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
