import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { powerBiAdapter } from "cloakroom-adapter-powerbi";
import { runUi } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/ui/dist/test
const fakeUpstream = join(here, "..", "..", "..", "cli", "dist", "test", "fixtures", "fake-upstream.js");

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

  // Serves the page.
  const page = await (await fetch(ui.url + "/")).text();
  assert.ok(page.includes("cloakroom admin"));

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
