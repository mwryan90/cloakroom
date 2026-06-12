/**
 * Power BI Desktop "External Tools" ribbon integration. Desktop scans a
 * well-known folder for *.pbitool.json files at startup and renders each as
 * a ribbon button; ours launches the cloakroom admin UI (reusing a running
 * instance via "ui --open"). The folder lives under Program Files, so
 * writing usually needs an elevated terminal — callers must treat failure
 * as a soft warning, never abort setup over it.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOAKROOM_ICON_DATA_URI } from "cloakroom-ui";

/** Override point for tests (and non-standard Power BI installs). */
export function externalToolsDir(): string {
  return (
    process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR ??
    "C:\\Program Files (x86)\\Common Files\\Microsoft Shared\\Power BI Desktop\\External Tools"
  );
}

export function externalToolPath(): string {
  return join(externalToolsDir(), "cloakroom.pbitool.json");
}

export interface ExternalToolResult {
  ok: boolean;
  message: string;
}

export function installExternalTool(): ExternalToolResult {
  if (process.platform !== "win32" && !process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR) {
    return { ok: false, message: "Power BI ribbon button skipped (Windows only)." };
  }
  const dir = externalToolsDir();
  if (!existsSync(dir)) {
    // No External Tools folder → Power BI Desktop isn't installed (or lives
    // somewhere exotic). Not an error; the proxy works fine without it.
    return { ok: false, message: `Power BI ribbon button skipped (no External Tools folder at ${dir}).` };
  }
  const tool = {
    version: "1.0.0",
    name: "Cloakroom",
    description:
      "Open the cloakroom masking admin UI: review columns, assign tokens. " +
      "Sensitive values never reach the AI agent.",
    path: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    arguments: "/c npx -y cloakroom ui --open",
    iconData: CLOAKROOM_ICON_DATA_URI,
  };
  try {
    writeFileSync(externalToolPath(), JSON.stringify(tool, null, 2));
    return {
      ok: true,
      message: "Power BI ribbon button installed -- restart Power BI Desktop to see it (External Tools).",
    };
  } catch (e) {
    if (isPermissionError(e)) {
      return {
        ok: false,
        message:
          "Power BI ribbon button NOT installed (needs admin rights to write under Program Files).\n" +
          '  Optional: re-run "npx cloakroom setup" from an Administrator terminal to add it.',
      };
    }
    return { ok: false, message: `Power BI ribbon button NOT installed: ${errText(e)}` };
  }
}

/** Returns null when there is nothing to remove. */
export function removeExternalTool(): ExternalToolResult | null {
  const p = externalToolPath();
  if (!existsSync(p)) return null;
  try {
    rmSync(p);
    return { ok: true, message: "Power BI ribbon button removed." };
  } catch (e) {
    return {
      ok: false,
      message: isPermissionError(e)
        ? `Power BI ribbon button NOT removed (needs admin rights). Delete manually: ${p}`
        : `Power BI ribbon button NOT removed: ${errText(e)}`,
    };
  }
}

function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
