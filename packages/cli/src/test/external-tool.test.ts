import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { externalToolPath, installExternalTool, removeExternalTool } from "../external-tool.js";

test("Power BI external tool installs valid JSON and removes cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "maskmcp-exttool-"));
  process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR = dir;
  try {
    const r = installExternalTool();
    assert.ok(r.ok, r.message);
    const p = externalToolPath();
    assert.ok(existsSync(p), "pbitool.json written");

    const tool = JSON.parse(readFileSync(p, "utf8")) as {
      version: string;
      name: string;
      path: string;
      arguments: string;
      iconData: string;
    };
    assert.equal(tool.name, "cloakroom");
    assert.ok(tool.arguments.includes("cloakroom ui --open"), "click launches/reuses the admin UI");
    assert.ok(tool.iconData.startsWith("data:image/png;base64,"), "icon is an embedded PNG data URI");
    assert.ok(tool.iconData.length > 1000, "icon actually embedded, not a placeholder");
    assert.ok(/cmd\.exe$/i.test(tool.path), "launcher is cmd.exe");

    const rm = removeExternalTool();
    assert.ok(rm?.ok, rm?.message);
    assert.ok(!existsSync(p), "file removed");
    assert.equal(removeExternalTool(), null, "second remove is a no-op");
  } finally {
    delete process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR;
  }
});

test("install skips gracefully when the External Tools folder is missing", () => {
  process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR = join(tmpdir(), `maskmcp-missing-${process.pid}`);
  try {
    const r = installExternalTool();
    assert.equal(r.ok, false);
    assert.match(r.message, /skipped/i);
  } finally {
    delete process.env.CLOAKROOM_EXTERNAL_TOOLS_DIR;
  }
});
