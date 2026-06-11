/**
 * Helpers for wiring cloakroom into MCP client configs (Claude Desktop et al.)
 * so users never have to know the underlying server command. The client app
 * spawns the servers; we just rewrite which command it spawns.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

interface ClientConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/** How the client should launch cloakroom itself. */
export interface Launcher {
  command: string;
  args: string[];
}

export const NPX_LAUNCHER: Launcher = { command: "npx", args: ["-y", "cloakroom"] };

/** Well-known Claude Desktop config locations (Windows, macOS, Linux). */
export function defaultClaudeConfigPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  if (process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, "Claude", "claude_desktop_config.json"));
  }
  paths.push(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  paths.push(join(home, ".config", "Claude", "claude_desktop_config.json"));
  return paths;
}

export function findClaudeConfig(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  return defaultClaudeConfigPaths().find((p) => existsSync(p));
}

export function listServers(configPath: string): Record<string, McpServerEntry> {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ClientConfig;
  return cfg.mcpServers ?? {};
}

export function isWrapped(entry: McpServerEntry): boolean {
  const blob = [entry.command, ...(entry.args ?? [])].join(" ");
  return (
    /(^|[\s/\\])cloakroom(\b|[\\/])/.test(blob) ||
    /(^|[\s/\\])mask-mcp(\b|[\\/])/.test(blob) || // legacy name (pre-0.3.0)
    /[\\/]cli[\\/]dist[\\/]index\.js/.test(blob)
  );
}

/** The real upstream command of an entry, whether or not it is wrapped. */
export function upstreamOf(entry: McpServerEntry): { command: string; args: string[] } {
  const args = entry.args ?? [];
  if (isWrapped(entry)) {
    const sep = args.indexOf("--");
    if (sep >= 0 && sep + 1 < args.length) {
      return { command: args[sep + 1], args: args.slice(sep + 2) };
    }
  }
  return { command: entry.command, args };
}

/**
 * The masking.yaml path a wrapped entry was set up with (the value after its
 * `--config` flag, before the `--` separator). Lets `ui` edit the SAME config
 * the proxy uses, regardless of which directory the user runs from. Returns
 * undefined if the entry is not wrapped or has no --config.
 */
export function maskingConfigOf(entry: McpServerEntry): string | undefined {
  if (!isWrapped(entry)) return undefined;
  const args = entry.args ?? [];
  const sep = args.indexOf("--");
  const cfg = args.indexOf("--config");
  if (cfg >= 0 && cfg + 1 < args.length && (sep < 0 || cfg < sep)) {
    return args[cfg + 1];
  }
  return undefined;
}

/**
 * Rewrite a server entry so the client spawns cloakroom, which spawns the
 * original server. A `.bak` copy of the config is written first.
 */
export function wrapServer(
  configPath: string,
  serverName: string,
  maskingConfigPath: string,
  adapterName = "powerbi",
  launcher: Launcher = NPX_LAUNCHER,
): void {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ClientConfig;
  const entry = cfg.mcpServers?.[serverName];
  if (!entry) throw new Error(`server "${serverName}" not found in ${configPath}`);
  if (isWrapped(entry)) throw new Error(`server "${serverName}" is already wrapped by cloakroom`);
  copyFileSync(configPath, configPath + ".bak");
  cfg.mcpServers![serverName] = {
    ...entry,
    command: launcher.command,
    args: [
      ...launcher.args,
      "--config",
      maskingConfigPath,
      "--adapter",
      adapterName,
      "--",
      entry.command,
      ...(entry.args ?? []),
    ],
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

/** Restore a wrapped entry to its original command. */
export function unwrapServer(configPath: string, serverName: string): void {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ClientConfig;
  const entry = cfg.mcpServers?.[serverName];
  if (!entry) throw new Error(`server "${serverName}" not found in ${configPath}`);
  if (!isWrapped(entry)) throw new Error(`server "${serverName}" is not wrapped by cloakroom`);
  const upstream = upstreamOf(entry);
  copyFileSync(configPath, configPath + ".bak");
  cfg.mcpServers![serverName] = { ...entry, command: upstream.command, args: upstream.args };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
