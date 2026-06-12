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
  const confirms: string[] = [];
  const dom = new JSDOM(html, {
    url: ui.url + "/",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(window) {
      (window as unknown as { fetch: typeof fetch }).fetch = ((path: string, opts?: RequestInit) =>
        fetch(new URL(path, ui.url).href, opts)) as typeof fetch;
      window.confirm = (m?: string) => {
        confirms.push(m ?? "");
        return true;
      };
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
  click(maskAll);
  await sleep(900);
  assert.equal(confirms.length, 1, "bulk masking asks for confirmation");
  assert.deepEqual(pageErrors, [], "no page errors during skip/restore/mask-all");
  assert.ok(readFileSync(cfgPath, "utf8").includes("Customer[Email]"), "rule written for text column");
  assert.ok(colNode("Customer[Email]")!.innerHTML.includes("tagged"), "column now tagged in list");
  assert.equal(doc.querySelector(".mask-all"), null, "button disappears once every text column is covered");
});
