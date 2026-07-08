/**
 * Browser-engine test: loads the REAL served page in jsdom against the real
 * UI server and clicks through every interaction. Exists because a scrambled
 * page script once shipped with dead click handlers that no API test caught.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { powerBiAdapter } from "cloakroom-adapter-powerbi";
import { runUi } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeUpstream = join(here, "..", "..", "..", "cli", "dist", "test", "fixtures", "fake-upstream.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("browser: page loads clean, columns clickable, mappings view works", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-browser-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [`mappingStore: ${join(tmp, "map.jsonl")}`, "columns:", '  - match: "Customer[Customer Name]"', "    prefix: Client"].join("\n"),
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

  // seed one mapping like the proxy would
  await fetch(ui.url + "/api/mappings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloakroom": "1" },
    body: JSON.stringify({ match: "Customer[Customer Name]", assignments: [{ value: "Contoso Ltd", token: "BigRetailer" }] }),
  });

  const html = await (await fetch(ui.url + "/")).text();
  const pageErrors: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => pageErrors.push(String(e)));
  const dom = new JSDOM(html, {
    url: ui.url + "/",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(window) {
      (window as unknown as { fetch: typeof fetch }).fetch = ((path: string, opts?: RequestInit) =>
        fetch(new URL(path, ui.url).href, opts)) as typeof fetch;
    },
  });
  const win = dom.window;
  win.addEventListener("error", (e) => pageErrors.push(`runtime: ${e.message} @${e.lineno}`));
  await sleep(700);
  const doc = win.document;

  assert.deepEqual(pageErrors, [], "page script must load without errors");
  assert.match(doc.getElementById("state")!.textContent ?? "", /v\d+\.\d+\.\d+/, "version stamp");

  // column click opens detail
  const cols = [...doc.querySelectorAll(".col")];
  assert.ok(cols.length >= 3, "columns rendered");
  const nameCol = cols.find((c) => c.getAttribute("data-key") === "Customer[Customer Name]")!;
  nameCol.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(700);
  assert.deepEqual(pageErrors, [], "no errors after column click");
  assert.ok(doc.getElementById("right")!.innerHTML.includes("distinct values"), "detail panel opened");
  assert.ok(doc.getElementById("f-save"), "rule form rendered");

  // mappings view
  doc.getElementById("view-toggle")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(700);
  assert.deepEqual(pageErrors, [], "no errors after toggle");
  assert.ok(doc.getElementById("right")!.innerHTML.includes("Token mappings"), "mappings view opened");
  assert.ok(doc.getElementById("map-table")!.innerHTML.includes("BigRetailer"), "mapping visible");

  // search filters
  const search = doc.getElementById("map-search") as unknown as { value: string; dispatchEvent(e: Event): boolean };
  search.value = "zzz-nope";
  search.dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(150);
  assert.ok(doc.getElementById("map-table")!.innerHTML.includes("No mappings match"), "filter works");
});

test("browser: source picker switches to a generic source's coverage card", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-browser3-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [`mappingStore: ${join(tmp, "map.jsonl")}`, "columns:", '  - match: "Customer[Customer Name]"', "    prefix: Client"].join("\n"),
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
        name: "fabric-dw",
        adapter: undefined,
        adapterName: "none",
        configPath: cfgPath,
        upstreamCommand: "never-spawned.exe",
        upstreamArgs: [],
      },
    ],
    port: 0,
    log: () => {},
  });
  t.after(async () => {
    await ui.close();
  });

  const html = await (await fetch(ui.url + "/")).text();
  const pageErrors: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => pageErrors.push(String(e)));
  const dom = new JSDOM(html, {
    url: ui.url + "/",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(window) {
      (window as unknown as { fetch: typeof fetch }).fetch = ((path: string, opts?: RequestInit) =>
        fetch(new URL(path, ui.url).href, opts)) as typeof fetch;
    },
  });
  const win = dom.window;
  win.addEventListener("error", (e) => pageErrors.push(`runtime: ${e.message} @${e.lineno}`));
  await sleep(700);
  const doc = win.document;

  // Picker rendered with both sources; adapter source selected + columns shown.
  const picker = doc.getElementById("source-picker") as unknown as {
    value: string;
    options: { length: number };
    dispatchEvent(e: Event): boolean;
  };
  assert.ok(picker, "source picker rendered with 2+ sources");
  assert.equal(picker.options.length, 2);
  assert.ok(doc.querySelectorAll(".col").length >= 3, "columns rendered for adapter source");
  assert.ok(doc.getElementById("state")!.textContent!.includes("powerbi-modeling-mcp"), "state shows source");

  // Switch to the generic source → coverage card, no column browser.
  picker.value = "fabric-dw";
  picker.dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(700);
  assert.deepEqual(pageErrors, [], "no page errors after source switch");
  const right = doc.getElementById("right")!.textContent!;
  assert.ok(right.includes("sweep-only coverage"), "coverage card shown");
  assert.ok(right.includes("NOT protected"), "coverage card states the gap");
  assert.ok(doc.getElementById("cols")!.textContent!.includes("No column browser"), "column list replaced");
  assert.ok(doc.getElementById("state")!.textContent!.includes("fabric-dw"), "state shows new source");

  // Manual warm-up through the coverage card's seed form.
  (doc.getElementById("seed-label") as unknown as { value: string }).value = "farms";
  (doc.getElementById("seed-prefix") as unknown as { value: string }).value = "Farm";
  (doc.getElementById("seed-values") as unknown as { value: string }).value = "Contoso Ltd\nFabrikam Inc\n";
  doc.getElementById("seed-apply")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(700);
  assert.deepEqual(pageErrors, [], "no page errors after seeding");
  const st = (await (await fetch(ui.url + "/api/state")).json()) as { storeCount: number };
  assert.equal(st.storeCount, 2, "seeded values registered in the store");
  assert.ok(doc.getElementById("right")!.textContent!.includes("farms"), "seeded group listed on the card");
});

test("browser: skip/restore a column and mask all text columns in a table", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maskmcp-browser2-"));
  const cfgPath = join(tmp, "masking.yaml");
  writeFileSync(
    cfgPath,
    [`mappingStore: ${join(tmp, "map.jsonl")}`, "columns:", '  - match: "Customer[Customer Name]"', "    prefix: Client"].join("\n"),
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

  const html = await (await fetch(ui.url + "/")).text();
  const pageErrors: string[] = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => pageErrors.push(String(e)));
  const dom = new JSDOM(html, {
    url: ui.url + "/",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(window) {
      (window as unknown as { fetch: typeof fetch }).fetch = ((path: string, opts?: RequestInit) =>
        fetch(new URL(path, ui.url).href, opts)) as typeof fetch;
    },
  });
  const win = dom.window;
  win.addEventListener("error", (e) => pageErrors.push(`runtime: ${e.message} @${e.lineno}`));
  await sleep(700);
  const doc = win.document;
  const click = (node: Element) => node.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const colNode = (key: string) =>
    [...doc.querySelectorAll(".col")].find((c) => c.getAttribute("data-key") === key);

  // Skip the suggested Email column ("Not sensitive").
  click(colNode("Customer[Email]")!);
  await sleep(500);
  assert.ok(doc.getElementById("f-dismiss"), "suggested column offers Not sensitive");
  click(doc.getElementById("f-dismiss")!);
  await sleep(500);
  assert.ok(colNode("Customer[Email]")!.innerHTML.includes("skipped"), "skipped badge visible in column list");
  assert.ok(doc.getElementById("f-undismiss"), "skipped column offers Restore");

  // Skipped columns are not bulk-maskable: with Email skipped, no eligible
  // text columns remain in Customer (Customer Name is already tagged).
  assert.equal(doc.querySelector(".mask-all"), null, "no mask-all button when nothing is eligible");

  // Restore (un-skip).
  click(doc.getElementById("f-undismiss")!);
  await sleep(500);
  assert.ok(colNode("Customer[Email]")!.innerHTML.includes("suggested"), "suggestion returns after restore");

  // Mask all text columns in Customer: only Email is eligible (Customer Name
  // tagged, Amount is Double).
  const maskAll = doc.querySelector(".mask-all")!;
  assert.ok(maskAll, "mask-all button visible again after restore");
  assert.ok(maskAll.textContent!.includes("(1)"), "eligible count shown");

  // The confirmation is an in-page modal: cancelling writes nothing.
  click(maskAll);
  await sleep(150);
  const modal = doc.getElementById("modal")!;
  assert.equal(modal.className, "open", "confirmation modal opens");
  assert.ok(doc.getElementById("modal-text")!.textContent!.includes("Email"), "modal lists the columns");
  click(doc.getElementById("modal-cancel")!);
  await sleep(300);
  assert.equal(modal.className, "", "modal closes on cancel");
  assert.ok(!readFileSync(cfgPath, "utf8").includes("Customer[Email]"), "cancel must not write rules");

  // Confirming masks the column.
  click(doc.querySelector(".mask-all")!);
  await sleep(150);
  click(doc.getElementById("modal-ok")!);
  await sleep(900);
  assert.equal(modal.className, "", "modal closes on confirm");
  assert.deepEqual(pageErrors, [], "no page errors during skip/restore/mask-all");
  assert.ok(readFileSync(cfgPath, "utf8").includes("Customer[Email]"), "rule written for text column");
  assert.ok(colNode("Customer[Email]")!.innerHTML.includes("tagged"), "column now tagged in list");
  assert.equal(doc.querySelector(".mask-all"), null, "button disappears once every text column is covered");
});
