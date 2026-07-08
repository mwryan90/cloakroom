#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, runProxy, type SourceAdapter } from "cloakroom-core";
import { powerBiAdapter } from "cloakroom-adapter-powerbi";
import { runUi, type UiSource } from "cloakroom-ui";
import {
  adapterOf,
  findClaudeConfig,
  isWrapped,
  listServers,
  maskingConfigOf,
  unwrapServer,
  upstreamOf,
  wrapServer,
} from "./claude-config.js";
import { installExternalTool, removeExternalTool } from "./external-tool.js";

const EXAMPLE_CONFIG = `# cloakroom configuration
# Values seen in these columns are replaced with stable tokens before they
# reach the AI agent. Run "cloakroom ui" for a guided setup.

mappingStore: ./masking-map.jsonl    # local only; this file IS the secret
tokenMode: sequential                # sequential ("Client 1") or hmac (team-consistent)
# hmacSecretEnv: MASK_TEAM_SECRET    # env var holding the shared team secret (hmac mode)
warmup: true                         # enumerate tagged columns at startup
readOnly: false                      # block model-mutating operations

columns:
  - match: "Customer[Customer Name]"
    mask: token
    prefix: Client
    exclude: ["UNKNOWN", "N/A"]
`;

// Shown whenever we can't find a Power BI MCP server to work with.
const POWERBI_HELP =
  "cloakroom wraps an existing Power BI MCP server; it does not install one.\n" +
  "  1. Install Microsoft's powerbi-modeling-mcp and add it to Claude Desktop:\n" +
  "     https://github.com/microsoft/powerbi-modeling-mcp\n" +
  "  2. Restart Claude Desktop so the server is registered.\n" +
  "  3. Re-run this command.";

function usage(): never {
  process.stderr.write(
    `Usage:
  cloakroom setup  [--server <name>] [--config masking.yaml] [--claude-config <path>]
                   [--no-external-tool]
      One-time install: wraps an MCP server entry in Claude Desktop's config so
      the app launches cloakroom automatically. No commands to copy. Restart
      Claude Desktop afterwards. Also adds a cloakroom button to Power BI
      Desktop's External Tools ribbon (skip with --no-external-tool).

  cloakroom unwrap [--server <name>] [--claude-config <path>]
      Undo setup; restores the original server entry and removes the Power BI
      ribbon button.

  cloakroom ui     [--server <name>] [--config masking.yaml] [--port 7682] [--open]
      Open the admin page (review columns, assign tokens, exclude placeholders).
      Manages EVERY cloakroom-wrapped server in Claude Desktop's config --
      switch between them in the header; --server picks the one shown first.
      Reuses an already-running instance; --open launches your browser.

  cloakroom init   [--config masking.yaml]
      Write an example masking.yaml.

Advanced (explicit upstream command instead of Claude Desktop discovery):
  cloakroom [ui] [--config masking.yaml] [--adapter powerbi|none] -- <server command...>

First time? Run "cloakroom setup", restart Claude Desktop, then "cloakroom ui".
`,
  );
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`[cloakroom] ${message}\n`);
  process.exit(1);
}

/**
 * Resolve the upstream server command from Claude Desktop's config, with
 * step-by-step guidance when something is missing.
 */
function resolveFromClaude(
  serverName: string | undefined,
  claudeConfigArg: string | undefined,
): {
  command: string;
  args: string[];
  configPath: string;
  serverName: string;
  wrapped: boolean;
  maskingConfig?: string;
} {
  const configPath = findClaudeConfig(claudeConfigArg);
  if (!configPath) {
    fail(
      "Could not find Claude Desktop's config (claude_desktop_config.json).\n\n" +
        POWERBI_HELP +
        "\n\n  Already configured elsewhere? Pass --claude-config <path>, or use the\n" +
        "  advanced form:  cloakroom ui -- <your powerbi server command>",
    );
  }
  const servers = listServers(configPath);
  const names = Object.keys(servers);
  if (names.length === 0) {
    fail(`No MCP servers are configured in ${configPath}.\n\n` + POWERBI_HELP);
  }
  let name = serverName;
  if (!name) {
    // Prefer an entry that looks like a Power BI server when not told which.
    const pbiLike = names.filter((n) => /power\s*bi|pbi|powerbi/i.test(n));
    if (names.length === 1) name = names[0];
    else if (pbiLike.length === 1) name = pbiLike[0];
    else
      fail(
        `Multiple MCP servers found in ${configPath}:\n` +
          names.map((n) => `    - ${n}`).join("\n") +
          `\n\n  Pick one with:  cloakroom <command> --server <name>`,
      );
  }
  const entry = servers[name!];
  if (!entry) {
    fail(
      `Server "${name}" not found in ${configPath}.\n` +
        `  Available: ${names.join(", ")}\n` +
        `  Pick one with --server <name>.`,
    );
  }
  const upstream = upstreamOf(entry);
  return {
    ...upstream,
    configPath,
    serverName: name!,
    wrapped: isWrapped(entry),
    maskingConfig: maskingConfigOf(entry),
  };
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Banner already shows the URL; opening the browser is best-effort.
  }
}

function uiBanner(url: string): void {
  const sep = "=".repeat(52);
  const banner = (): void => {
    process.stderr.write(
      "\n" +
        sep +
        "\n  cloakroom admin UI is running\n  Open in your browser:  " +
        url +
        "\n  Press Ctrl+C here to stop it.\n" +
        sep +
        "\n\n",
    );
  };
  banner();
  setTimeout(banner, 1500).unref();
}

/** True if a cloakroom admin UI is already serving on this port. */
async function probeExistingUi(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return false;
    const state = (await res.json()) as { configPath?: unknown };
    return typeof state.configPath === "string";
  } catch {
    return false;
  }
}

function ensureMaskingConfig(configPath: string): string {
  const p = resolve(configPath);
  if (!existsSync(p)) {
    writeFileSync(p, EXAMPLE_CONFIG);
    process.stderr.write(`[cloakroom] wrote ${p}\n`);
  }
  return p;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let configPath = "masking.yaml";
  let configExplicit = false;
  let adapterName = "powerbi";
  let serverName: string | undefined;
  let claudeConfigArg: string | undefined;
  let port: number | undefined;
  let open = false;
  let noExternalTool = false;
  let mode: "proxy" | "init" | "ui" | "setup" | "unwrap" = "proxy";
  let upstream: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "init" || a === "ui" || a === "setup" || a === "unwrap") mode = a;
    else if (a === "--config") { configPath = argv[++i] ?? usage(); configExplicit = true; }
    else if (a === "--adapter") adapterName = argv[++i] ?? usage();
    else if (a === "--server") serverName = argv[++i] ?? usage();
    else if (a === "--claude-config") claudeConfigArg = argv[++i] ?? usage();
    else if (a === "--port") port = Number(argv[++i] ?? usage());
    else if (a === "--open") open = true;
    else if (a === "--no-external-tool") noExternalTool = true;
    else if (a === "--") {
      upstream = argv.slice(i + 1);
      break;
    } else usage();
  }

  if (mode === "init") {
    const p = resolve(configPath);
    if (existsSync(p)) fail(`Refusing to overwrite existing ${p}`);
    writeFileSync(p, EXAMPLE_CONFIG);
    process.stderr.write(`Wrote ${p} -- run "cloakroom setup" to wire it into Claude Desktop.\n`);
    return;
  }

  if (mode === "setup") {
    const target = resolveFromClaude(serverName, claudeConfigArg);
    if (target.wrapped) {
      process.stderr.write(
        `[cloakroom] "${target.serverName}" is already protected by cloakroom. Nothing to do.\n` +
          `  Run "cloakroom ui" to choose which columns to mask.\n`,
      );
      // Still (re)install the ribbon button so existing installs pick it up.
      if (!noExternalTool) {
        const ext = installExternalTool();
        process.stderr.write(`[cloakroom] ${ext.message}\n`);
      }
      return;
    }
    const masking = ensureMaskingConfig(configPath);
    const selfPath = fileURLToPath(import.meta.url);
    const launcher = /[\\/]_npx[\\/]/.test(selfPath)
      ? undefined // published install -> default npx launcher
      : { command: process.execPath, args: [selfPath] };
    wrapServer(target.configPath, target.serverName, masking, adapterName, launcher);
    const ext = noExternalTool ? null : installExternalTool();
    process.stderr.write(
      `\n${"=".repeat(56)}\n` +
        `  cloakroom is now wrapping "${target.serverName}"\n` +
        `  config: ${target.configPath} (backup saved as .bak)\n` +
        `  masking rules: ${masking}\n` +
        (ext ? `  ${ext.message}\n` : "") +
        `\n  NEXT STEPS:\n` +
        `  1. Fully quit and reopen Claude Desktop (not just close the window)\n` +
        `  2. Open your model in Power BI Desktop\n` +
        `  3. Run "npx cloakroom ui" to choose which columns to mask\n` +
        `${"=".repeat(56)}\n\n`,
    );
    return;
  }

  if (mode === "unwrap") {
    const target = resolveFromClaude(serverName, claudeConfigArg);
    if (!target.wrapped) {
      fail(`"${target.serverName}" is not wrapped by cloakroom -- nothing to undo.`);
    }
    unwrapServer(target.configPath, target.serverName);
    const ext = removeExternalTool();
    process.stderr.write(
      `[cloakroom] restored "${target.serverName}" in ${target.configPath}.\n` +
        (ext ? `  ${ext.message}\n` : "") +
        `  Restart Claude Desktop for it to take effect.\n`,
    );
    return;
  }

  const adapters: Record<string, SourceAdapter | undefined> = {
    powerbi: powerBiAdapter,
    none: undefined,
  };
  if (!(adapterName in adapters)) usage();
  const adapter = adapters[adapterName];

  // Reuse a running admin UI instead of dying with "port in use" — this is
  // what makes the Power BI ribbon button idempotent.
  if (mode === "ui") {
    const uiPort = port ?? 7682;
    if (uiPort > 0 && (await probeExistingUi(uiPort))) {
      const url = `http://127.0.0.1:${uiPort}`;
      process.stderr.write(
        `[cloakroom] admin UI already running at ${url}${open ? " -- opening browser" : ""}\n`,
      );
      if (open) openBrowser(url);
      return;
    }
  }

  // Admin UI over every cloakroom-wrapped server in one place: rules,
  // discovery, and triage are per source; the mapping store is shared
  // wherever their configs point at the same file. Falls back to the
  // single-source path for explicit upstreams (`--`), unwrapped --server
  // targets, and configs with nothing wrapped yet.
  if (mode === "ui" && upstream.length === 0) {
    const claudePath = findClaudeConfig(claudeConfigArg);
    const servers = claudePath ? listServers(claudePath) : {};
    const wrappedNames = Object.keys(servers).filter((n) => isWrapped(servers[n]));
    const explicitUnwrapped = serverName !== undefined && !wrappedNames.includes(serverName);
    if (wrappedNames.length > 0 && !explicitUnwrapped) {
      const sources: UiSource[] = wrappedNames.map((n) => {
        const entry = servers[n];
        const up = upstreamOf(entry);
        const adapterName = adapterOf(entry) ?? "powerbi";
        return {
          name: n,
          adapter: adapters[adapterName],
          adapterName,
          configPath: maskingConfigOf(entry) ?? ensureMaskingConfig(configPath),
          upstreamCommand: up.command,
          upstreamArgs: up.args,
        };
      });
      process.stderr.write(
        `[cloakroom] managing ${sources.length} masked server(s): ` +
          sources.map((sp) => `${sp.name} (${sp.adapter ? sp.adapterName : "sweep-only"})`).join(", ") +
          "\n",
      );
      const handle = await runUi({ sources, initialSource: serverName, port });
      uiBanner(handle.url);
      if (open) openBrowser(handle.url);
      return; // server keeps the process alive
    }
  }

  // No explicit upstream command? Discover it via Claude Desktop's config.
  let wrapped = true;
  if (upstream.length === 0) {
    const target = resolveFromClaude(serverName, claudeConfigArg);
    upstream = [target.command, ...target.args];
    wrapped = target.wrapped;
    // Use the SAME masking.yaml setup recorded, so this works from any directory.
    if (!configExplicit && target.maskingConfig) {
      configPath = target.maskingConfig;
      process.stderr.write(`[cloakroom] using masking config ${configPath}\n`);
    }
    process.stderr.write(
      `[cloakroom] using server "${target.serverName}" from ${target.configPath}\n`,
    );
  }

  if (mode === "ui") {
    if (!adapter) fail("The admin UI requires an adapter with schema discovery (e.g. --adapter powerbi)");
    // If setup hasn't been run, the UI still works for configuring rules, but
    // Claude itself isn't masking yet -- make that explicit.
    if (!wrapped) {
      process.stderr.write(
        `\n${"-".repeat(56)}\n` +
          `  NOTE: cloakroom setup has not been run yet.\n` +
          `  You can configure masking rules here, but Claude Desktop is NOT\n` +
          `  masking through cloakroom until you run:\n\n` +
          `      npx cloakroom setup\n\n` +
          `  ...then fully restart Claude Desktop.\n` +
          `${"-".repeat(56)}\n`,
      );
    }
    const masking = ensureMaskingConfig(configPath);
    const handle = await runUi({
      configPath: masking,
      adapter,
      upstreamCommand: upstream[0],
      upstreamArgs: upstream.slice(1),
      port,
    });
    uiBanner(handle.url);
    if (open) openBrowser(handle.url);
    return; // server keeps the process alive
  }

  if (!existsSync(configPath)) fail(`Config not found: ${configPath} (run "cloakroom init" first)`);
  await runProxy({
    config: loadConfig(configPath),
    configPath: resolve(configPath),
    adapter,
    upstreamCommand: upstream[0],
    upstreamArgs: upstream.slice(1),
  });
}

main().catch((e) => {
  process.stderr.write(`[cloakroom] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
