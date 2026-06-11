import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SENSITIVE = ["Contoso Ltd", "Fabrikam Inc", "Adventure Works"];

const here = dirname(fileURLToPath(import.meta.url)); // .../packages/cli/dist/test
const cliEntry = join(here, "..", "index.js");
const fakeUpstream = join(here, "fixtures", "fake-upstream.js");

async function startProxy(): Promise<Client> {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-e2e-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "tokenMode: sequential",
      "warmup: true",
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    mask: token",
      "    prefix: Client",
    ].join("\n"),
  );
  const client = new Client({ name: "e2e-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, "--config", cfgPath, "--adapter", "powerbi", "--", process.execPath, fakeUpstream],
    }),
  );
  return client;
}

test("e2e: proxy mirrors tools, masks outputs, unmasks inputs, never leaks", async (t) => {
  const client = await startProxy();
  t.after(async () => {
    await client.close();
  });

  const transcripts: string[] = [];
  const record = <T>(r: T): T => {
    transcripts.push(JSON.stringify(r));
    return r;
  };

  // Tools are mirrored, annotated, and masking_info is added.
  const tools = record(await client.listTools());
  const names = tools.tools.map((x) => x.name);
  for (const n of ["dax_query_operations", "run_dax", "check_filter", "boom", "crash", "masking_info"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  const runDax = tools.tools.find((x) => x.name === "run_dax");
  assert.ok(runDax?.description?.includes("cloakroom"), "tool descriptions should carry the token note");

  // masking_info describes the masking layer without leaking values.
  const info = record(await client.callTool({ name: "masking_info", arguments: {} }));
  const infoText = JSON.stringify(info);
  assert.ok(infoText.includes("maskingActive"));
  assert.ok(infoText.includes("Customer[Customer Name]"));

  // Query results are masked, grouping preserved, and temp-file paths redacted.
  const res = record(await client.callTool({ name: "run_dax", arguments: {} }));
  const resText = JSON.stringify(res);
  assert.ok(resText.includes("Client 1"), "expected token in result");
  assert.ok(!resText.includes("fake_query_result"), "raw temp-file path must be redacted");
  assert.ok(resText.includes("file:///masked/query-result"), "redacted placeholder expected");

  // Inbound unmasking: filtering by token hits the real value upstream.
  // (Warm-up registered Contoso Ltd first → Client 1.)
  const match = record(await client.callTool({ name: "check_filter", arguments: { client: "Client 1" } }));
  assert.ok(JSON.stringify(match).includes("MATCH"), "token filter did not reach upstream as real value");

  // Unknown tokens fail closed.
  const unknown = record(await client.callTool({ name: "check_filter", arguments: { client: "Client 99" } }));
  assert.ok((unknown as { isError?: boolean }).isError, "unknown token should error");
  assert.ok(JSON.stringify(unknown).includes("Unknown masked token"));

  // Error results and thrown errors are masked too.
  const boom = record(await client.callTool({ name: "boom", arguments: {} }));
  assert.ok(JSON.stringify(boom).includes("Client 1"), "error text should carry token, not raw value");
  const crash = record(await client.callTool({ name: "crash", arguments: {} }));
  assert.ok((crash as { isError?: boolean }).isError);

  // Prompts and resources are mirrored through the proxy — and masked.
  const prompts = record(await client.listPrompts());
  assert.ok(prompts.prompts.some((x) => x.name === "dax_help"), "prompts must be mirrored");
  const prompt = record(await client.getPrompt({ name: "dax_help", arguments: {} }));
  assert.ok(JSON.stringify(prompt).includes("Client 1"), "prompt content must be masked");
  const resources = record(await client.listResources());
  assert.ok(resources.resources.some((x) => x.uri === "guide://dax"));
  const doc = record(await client.readResource({ uri: "guide://dax" }));
  assert.ok(JSON.stringify(doc).includes("Client 2"), "resource content must be masked");

  // THE LEAK TEST: nothing the client ever received contains a raw value.
  const everything = transcripts.join("\n");
  for (const v of SENSITIVE) {
    assert.ok(!everything.includes(v), `LEAK: "${v}" reached the client`);
  }
});

test("e2e: rules saved to masking.yaml hot-reload into a running proxy", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-reload-"));
  const cfgPath = join(tmp, "masking.yaml");
  // Start with a rule that matches nothing.
  writeFileSync(
    cfgPath,
    [`mappingStore: ${join(tmp, "map.jsonl")}`, "columns:", '  - match: "Nothing[Nothing]"'].join("\n"),
  );
  const client = new Client({ name: "reload-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, "--config", cfgPath, "--adapter", "powerbi", "--", process.execPath, fakeUpstream],
    }),
  );
  t.after(async () => {
    await client.close();
  });

  // Baseline: no matching rule → names pass through (nothing registered).
  const before = await client.callTool({ name: "run_dax", arguments: {} });
  assert.ok(JSON.stringify(before).includes("Contoso Ltd"), "baseline: no rule, no masking");

  // User saves a rule in the admin UI → masking.yaml changes on disk.
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );
  await new Promise((r) => setTimeout(r, 1700)); // past the reload throttle

  // First call after reload triggers the config re-read; registration happens
  // on sight, so the result is masked.
  const after = await client.callTool({ name: "run_dax", arguments: {} });
  const text = JSON.stringify(after);
  assert.ok(!text.includes("Contoso Ltd"), "rule must hot-apply without restart");
  assert.ok(text.includes("Client"), "token expected after reload");
});

test("e2e: file:// resource reads are blocked by the proxy", async (t) => {
  const client = await startProxy();
  t.after(async () => {
    await client.close();
  });
  await assert.rejects(
    () => client.readResource({ uri: "file:///C:/Users/x/Temp/raw_query_result.csv" }),
    /file:\/\/ resources are blocked/,
  );
  // legitimate resources still work
  const doc = await client.readResource({ uri: "guide://dax" });
  assert.ok(JSON.stringify(doc).length > 0);
});
