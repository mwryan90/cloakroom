import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { powerBiAdapter } from "cloakroom-adapter-powerbi";
import { runUi } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/ui/dist/test
const fakeUpstream = join(here, "..", "..", "..", "cli", "dist", "test", "fixtures", "fake-upstream.js");

test("UI auto-connects when Power BI opens after startup", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-ui-late-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );

  // No Power BI "open" until the flag file exists.
  const flag = join(tmp, "pbi-open.flag");
  process.env.FAKE_EMPTY_UNTIL_FILE = flag;
  let ui;
  try {
    ui = await runUi({
      configPath: cfgPath,
      adapter: powerBiAdapter,
      upstreamCommand: process.execPath,
      upstreamArgs: [fakeUpstream],
      port: 0,
      log: () => {},
    });
  } finally {
    delete process.env.FAKE_EMPTY_UNTIL_FILE; // child captured it at spawn
  }
  t.after(async () => {
    await ui.close();
  });

  // Startup with nothing open → not connected, no models.
  const st0 = (await (await fetch(ui.url + "/api/state")).json()) as { connection: string };
  assert.match(st0.connection, /NOT CONNECTED/);
  const m0 = (await (await fetch(ui.url + "/api/models")).json()) as {
    models: string[];
    connection: string;
  };
  assert.deepEqual(m0.models, []);
  assert.match(m0.connection, /NOT CONNECTED/, "no auto-connect while nothing is open");

  // "Open" Power BI; the next models poll must auto-connect.
  writeFileSync(flag, "");
  const m1 = (await (await fetch(ui.url + "/api/models")).json()) as {
    models: string[];
    connection: string;
  };
  assert.equal(m1.models.length, 2);
  assert.match(m1.connection, /connected to Fake Model/, "models poll triggers reconnect");
  const st1 = (await (await fetch(ui.url + "/api/state")).json()) as { connection: string };
  assert.match(st1.connection, /connected to Fake Model/);
});

test("re-token renames sequential tokens to a new prefix, keeps custom tokens", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-ui-retoken-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );
  const ui = await runUi({
    configPath: cfgPath,
    adapter: powerBiAdapter,
    upstreamCommand: process.execPath,
    upstreamArgs: [fakeUpstream],
    port: 0,
    log: () => {},
  });
  t.after(async () => {
    await ui.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(ui.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloakroom": "1" },
      body: JSON.stringify(body),
    });

  // Two automatic tokens (Client 1/2) and one custom.
  await post("/api/mappings", {
    match: "Customer[Customer Name]",
    assignments: [
      { value: "Contoso Ltd" },
      { value: "Fabrikam Inc" },
      { value: "Adventure Works", token: "BigRetailer" },
    ],
  });

  // Change the prefix, then rename existing tokens.
  await post("/api/rule", { match: "Customer[Customer Name]", mask: "token", prefix: "Customer" });
  const rr = (await (
    await post("/api/retoken", { match: "Customer[Customer Name]", fromPrefix: "Client" })
  ).json()) as { renamed: number; kept: number; conflicts: number };
  assert.equal(rr.renamed, 2, "both sequential tokens renamed");
  assert.equal(rr.kept, 1, "custom token kept");
  assert.equal(rr.conflicts, 0);

  const list = (await (await fetch(ui.url + "/api/mappings-list")).json()) as {
    mappings: { value: string; token: string }[];
  };
  const tok = (v: string) => list.mappings.find((m) => m.value === v)?.token;
  assert.equal(tok("Contoso Ltd"), "Customer 1", "number preserved across rename");
  assert.equal(tok("Fabrikam Inc"), "Customer 2");
  assert.equal(tok("Adventure Works"), "BigRetailer", "custom token untouched");

  // Re-running is a no-op (old pattern no longer matches anything).
  const rr2 = (await (
    await post("/api/retoken", { match: "Customer[Customer Name]", fromPrefix: "Client" })
  ).json()) as { renamed: number };
  assert.equal(rr2.renamed, 0);
});

test("UI detects when the connected model is closed and reconnects", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-ui-stale-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );

  // Power BI "open" from the start; the flag file's presence controls it.
  const flag = join(tmp, "pbi-open.flag");
  writeFileSync(flag, "");
  process.env.FAKE_EMPTY_UNTIL_FILE = flag;
  let ui;
  try {
    ui = await runUi({
      configPath: cfgPath,
      adapter: powerBiAdapter,
      upstreamCommand: process.execPath,
      upstreamArgs: [fakeUpstream],
      port: 0,
      log: () => {},
    });
  } finally {
    delete process.env.FAKE_EMPTY_UNTIL_FILE; // child captured it at spawn
  }
  t.after(async () => {
    await ui.close();
  });
  const poll = async () =>
    (await (await fetch(ui.url + "/api/models")).json()) as { models: string[]; connection: string };

  // Connected at startup; the first poll resolves which model we're on.
  const p0 = await poll();
  assert.match(p0.connection, /connected to Fake Model/);

  // "Close" Power BI: the next poll must notice the connected model is gone
  // and degrade to NOT CONNECTED instead of staying silently stale.
  rmSync(flag);
  const p1 = await poll();
  assert.deepEqual(p1.models, []);
  assert.match(p1.connection, /NOT CONNECTED/, "stale connection detected when the file closes");

  // "Reopen" it: the poll auto-connects again.
  writeFileSync(flag, "");
  const p2 = await poll();
  assert.match(p2.connection, /connected to Fake Model/, "recovers when a file opens again");
});

test("multi-source: picker data, generic coverage, shared store, switching", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-ui-multi-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );

  const ui = await runUi({
    sources: [
      {
        name: "powerbi-modeling-mcp",
        adapter: powerBiAdapter,
        adapterName: "powerbi",
        configPath: cfgPath,
        upstreamCommand: process.execPath,
        upstreamArgs: [fakeUpstream],
      },
      {
        // Generic source: must never be spawned — a bogus command proves it.
        name: "fabric-dw",
        adapter: undefined,
        adapterName: "none",
        configPath: cfgPath,
        upstreamCommand: "this-command-does-not-exist.exe",
        upstreamArgs: [],
      },
    ],
    port: 0,
    log: () => {},
  });
  t.after(async () => {
    await ui.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(ui.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloakroom": "1" },
      body: JSON.stringify(body),
    });

  // Defaults to the source WITH an adapter; both are listed.
  const src0 = (await (await fetch(ui.url + "/api/sources")).json()) as {
    current: string;
    sources: { name: string; generic: boolean; connected: boolean }[];
  };
  assert.equal(src0.current, "powerbi-modeling-mcp");
  assert.equal(src0.sources.length, 2);
  assert.equal(src0.sources.find((x) => x.name === "fabric-dw")?.generic, true);

  // Seed a mapping through the adapter source.
  await post("/api/mappings", {
    match: "Customer[Customer Name]",
    assignments: [{ value: "Contoso Ltd", token: "BigRetailer" }],
  });

  // Switch to the generic source: no spawn, sweep-only status, no discovery.
  const sw = (await (
    await post("/api/source", { name: "fabric-dw" })
  ).json()) as { ok: boolean; generic: boolean; connection: string };
  assert.ok(sw.ok);
  assert.equal(sw.generic, true);
  assert.match(sw.connection, /sweep-only/);

  const st = (await (await fetch(ui.url + "/api/state")).json()) as {
    source: string;
    generic: boolean;
    storeCount: number;
  };
  assert.equal(st.source, "fabric-dw");
  assert.equal(st.generic, true);
  assert.equal(st.storeCount, 1, "store is shared: mapping seeded via Power BI is visible here");

  const colsRes = await fetch(ui.url + "/api/columns");
  assert.equal(colsRes.status, 400, "generic sources have no schema discovery");

  // The shared-store decoder still works from the generic source.
  const lookup = (await (
    await fetch(ui.url + "/api/lookup?q=" + encodeURIComponent("BigRetailer"))
  ).json()) as { value: string }[];
  assert.equal(lookup[0]?.value, "Contoso Ltd");

  // Switch back: discovery works again.
  await post("/api/source", { name: "powerbi-modeling-mcp" });
  const cols = (await (await fetch(ui.url + "/api/columns")).json()) as { key: string }[];
  assert.ok(cols.some((c) => c.key === "Customer[Customer Name]"));

  // Unknown source is rejected.
  const bad = await post("/api/source", { name: "nope" });
  assert.equal(bad.status, 400);
});

test("admin UI API: discover, sample, save rule, assign mappings", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-ui-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [
      `mappingStore: ${join(tmp, "map.jsonl")}`,
      "columns:",
      '  - match: "Customer[Customer Name]"',
      "    prefix: Client",
    ].join("\n"),
  );

  const ui = await runUi({
    configPath: cfgPath,
    adapter: powerBiAdapter,
    upstreamCommand: process.execPath,
    upstreamArgs: [fakeUpstream],
    port: 0,
    log: () => {},
  });
  t.after(async () => {
    await ui.close();
  });

  // POSTs without the anti-CSRF header are rejected.
  const noHeader = await fetch(ui.url + "/api/rule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ match: "X[Y]" }),
  });
  assert.equal(noHeader.status, 403);

  // Serves the page, branded and with the favicon embedded.
  const page = await (await fetch(ui.url + "/")).text();
  assert.ok(page.includes("Cloakroom admin"));
  assert.ok(page.includes('rel="icon"'), "favicon link present");
  assert.ok(!page.includes("__CLOAKROOM_ICON__"), "icon placeholder replaced");
  assert.ok(!page.includes("__CLOAKROOM_VERSION__"), "version placeholder replaced");

  // Schema discovery with tagged/suggested flags.
  const cols = (await (await fetch(ui.url + "/api/columns")).json()) as {
    key: string;
    tagged: string | null;
    suggested: boolean;
  }[];
  const nameCol = cols.find((c) => c.key === "Customer[Customer Name]");
  const emailCol = cols.find((c) => c.key === "Customer[Email]");
  assert.ok(nameCol?.tagged, "existing rule should mark column tagged");
  assert.ok(emailCol?.suggested, "email column should be suggested");

  // Sampling: low cardinality → editable.
  const detail = (await (
    await fetch(ui.url + "/api/column?table=Customer&column=Customer%20Name")
  ).json()) as { editable: boolean; distinctCount: number; values: { value: string }[] };
  assert.equal(detail.distinctCount, 3);
  assert.ok(detail.editable);
  assert.equal(detail.values.length, 3);

  // Save a rule for Email.
  const ruleRes = await fetch(ui.url + "/api/rule", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ match: "Customer[Email]", mask: "email", prefix: "Client" }),
  });
  assert.ok(ruleRes.ok);
  assert.ok(readFileSync(cfgPath, "utf8").includes("Customer[Email]"));

  // Manual + automatic token assignment.
  const mapRes = (await (
    await fetch(ui.url + "/api/mappings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloakroom": "1" },
      body: JSON.stringify({
        match: "Customer[Customer Name]",
        assignments: [
          { value: "Contoso Ltd", token: "BigRetailer" },
          { value: "Fabrikam Inc" }, // auto
        ],
      }),
    })
  ).json()) as { applied: number; storeCount: number };
  assert.equal(mapRes.applied, 2);
  const store = readFileSync(join(tmp, "map.jsonl"), "utf8");
  assert.ok(store.includes("BigRetailer"));
  assert.ok(store.includes("Client 1"), "auto assignment should produce sequential token");

  // Model switcher: list and switch.
  const models = (await (await fetch(ui.url + "/api/models")).json()) as { models: string[] };
  assert.deepEqual(models.models, ["Fake Model", "Other Model"]);
  const sw = (await (
    await fetch(ui.url + "/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloakroom": "1" },
      body: JSON.stringify({ model: "Other Model" }),
    })
  ).json()) as { ok: boolean; connection: string };
  assert.ok(sw.ok);
  assert.ok(sw.connection.includes("Other Model"));

  // Exclude list round-trips through the yaml and blocks manual assignment.
  const exclRes = await fetch(ui.url + "/api/rule", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ match: "Customer[Customer Name]", mask: "token", prefix: "Client", exclude: ["UNKNOWN"] }),
  });
  assert.ok(exclRes.ok);
  assert.ok(readFileSync(cfgPath, "utf8").includes("UNKNOWN"));
  const exclMap = (await (
    await fetch(ui.url + "/api/mappings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloakroom": "1" },
      body: JSON.stringify({
        match: "Customer[Customer Name]",
        assignments: [{ value: "UNKNOWN", token: "ShouldNotHappen" }],
      }),
    })
  ).json()) as { applied: number };
  assert.equal(exclMap.applied, 0, "excluded values must not be assignable");

  // Dismissing a false-positive suggestion persists and hides the badge.
  const dis = await fetch(ui.url + "/api/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ key: "Customer[Email]" }),
  });
  assert.ok(dis.ok);
  assert.ok(readFileSync(cfgPath, "utf8").includes("dismissed"));
  const cols2 = (await (await fetch(ui.url + "/api/columns")).json()) as {
    key: string;
    suggested: boolean;
    dismissed: boolean;
  }[];
  const email2 = cols2.find((c) => c.key === "Customer[Email]");
  assert.equal(email2?.suggested, false, "dismissed column no longer suggested");
  assert.equal(email2?.dismissed, true);

  // ...and dismissal is reversible (un-skip).
  const undis = await fetch(ui.url + "/api/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ key: "Customer[Email]", undo: true }),
  });
  assert.ok(undis.ok);
  const cols3 = (await (await fetch(ui.url + "/api/columns")).json()) as {
    key: string;
    dismissed: boolean;
  }[];
  assert.equal(
    cols3.find((c) => c.key === "Customer[Email]")?.dismissed,
    false,
    "restored column no longer dismissed",
  );

  // The decoder finds mappings by token AND by real value.
  const byToken = (await (
    await fetch(ui.url + "/api/lookup?q=" + encodeURIComponent("BigRetailer"))
  ).json()) as { token: string; value: string }[];
  assert.equal(byToken.length, 1);
  assert.equal(byToken[0].value, "Contoso Ltd");
  const byValue = (await (
    await fetch(ui.url + "/api/lookup?q=" + encodeURIComponent("fabrikam"))
  ).json()) as { token: string; value: string }[];
  assert.ok(byValue.some((r) => r.token === "Client 1"));

  // Saving a rule triggers a warm-up scan through the UI's own connection.
  await fetch(ui.url + "/api/rule", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ match: "Customer[Customer Name]", mask: "token", prefix: "Client" }),
  });
  let warmed = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const st = (await (await fetch(ui.url + "/api/state")).json()) as { storeCount: number };
    warmed = st.storeCount;
    if (warmed >= 3) break;
  }
  assert.ok(warmed >= 3, `warm-up should register all column values (got ${warmed})`);

  // Mappings browser lists everything with column groups.
  const list = (await (await fetch(ui.url + "/api/mappings-list")).json()) as {
    total: number;
    mappings: { token: string; value: string; group: string }[];
  };
  assert.ok(list.total >= 2);
  const big = list.mappings.find((m) => m.token === "BigRetailer");
  assert.equal(big?.value, "Contoso Ltd");
  assert.ok(big?.group.includes("customer"), "group should identify the column");

  // Duplicate token must be rejected.
  const dup = await fetch(ui.url + "/api/mappings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({
      match: "Customer[Customer Name]",
      assignments: [{ value: "Adventure Works", token: "BigRetailer" }],
    }),
  });
  assert.equal(dup.status, 500);
});
