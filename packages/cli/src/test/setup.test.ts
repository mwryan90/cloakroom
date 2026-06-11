import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isWrapped,
  listServers,
  maskingConfigOf,
  unwrapServer,
  upstreamOf,
  wrapServer,
} from "../claude-config.js";

function makeConfig(): string {
  const p = join(mkdtempSync(join(tmpdir(), "maskmcp-setup-")), "claude_desktop_config.json");
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: {
        powerbi: {
          command: "C:\\tools\\powerbi-modeling-mcp.exe",
          args: ["--stdio"],
          env: { FOO: "bar" },
        },
      },
      otherSetting: true,
    }),
  );
  return p;
}

test("wrap rewrites the entry, keeps env, backs up, and survives unwrap", () => {
  const p = makeConfig();
  wrapServer(p, "powerbi", "C:\\masking\\masking.yaml");

  assert.ok(existsSync(p + ".bak"), "backup written");
  const wrapped = listServers(p)["powerbi"];
  assert.ok(isWrapped(wrapped));
  assert.equal(wrapped.command, "npx");
  assert.deepEqual(wrapped.env, { FOO: "bar" }, "env preserved");
  assert.ok(wrapped.args!.includes("--"), "separator present");

  // The original command is recoverable.
  const up = upstreamOf(wrapped);
  assert.equal(up.command, "C:\\tools\\powerbi-modeling-mcp.exe");
  assert.deepEqual(up.args, ["--stdio"]);

  // Other settings untouched.
  const raw = JSON.parse(readFileSync(p, "utf8")) as { otherSetting?: boolean };
  assert.equal(raw.otherSetting, true);

  // Unwrap restores the original.
  unwrapServer(p, "powerbi");
  const restored = listServers(p)["powerbi"];
  assert.ok(!isWrapped(restored));
  assert.equal(restored.command, "C:\\tools\\powerbi-modeling-mcp.exe");
  assert.deepEqual(restored.args, ["--stdio"]);
});

test("double-wrap is rejected; unwrap of unwrapped is rejected", () => {
  const p = makeConfig();
  wrapServer(p, "powerbi", "/tmp/masking.yaml");
  assert.throws(() => wrapServer(p, "powerbi", "/tmp/masking.yaml"), /already wrapped/);
  unwrapServer(p, "powerbi");
  assert.throws(() => unwrapServer(p, "powerbi"), /not wrapped/);
});

test("upstreamOf passes through unwrapped entries", () => {
  const p = makeConfig();
  const entry = listServers(p)["powerbi"];
  const up = upstreamOf(entry);
  assert.equal(up.command, "C:\\tools\\powerbi-modeling-mcp.exe");
  assert.deepEqual(up.args, ["--stdio"]);
});

test("maskingConfigOf recovers the --config path from a wrapped entry", () => {
  const p = makeConfig();
  wrapServer(p, "powerbi", "C:\\masking\\masking.yaml");
  const entry = listServers(p)["powerbi"];
  assert.equal(maskingConfigOf(entry), "C:\\masking\\masking.yaml");
  // unwrapped entries have no recorded masking config
  unwrapServer(p, "powerbi");
  assert.equal(maskingConfigOf(listServers(p)["powerbi"]), undefined);
});
