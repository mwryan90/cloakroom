import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ColumnHit, SourceAdapter } from "../adapter.js";
import { ConfigSchema } from "../config.js";
import { MaskingPipeline, UnknownTokenError } from "../pipeline.js";
import { MappingStore } from "../store.js";

const SENSITIVE = ["Contoso Ltd", "Fabrikam Inc", "Adventure Works", "info@contoso.com"];

function makePipeline() {
  const cfg = ConfigSchema.parse({
    columns: [
      { match: "Customer[Customer Name]", mask: "token", prefix: "Client" },
      { match: "Customer[Email]", mask: "email", prefix: "Client", linkTo: "Customer[Customer Name]" },
    ],
  });
  const store = new MappingStore(join(mkdtempSync(join(tmpdir(), "maskmcp-")), "map.jsonl"), {
    mode: "sequential",
  });
  // A minimal adapter: hits come from objects keyed `Table[Column]`.
  const adapter: SourceAdapter = {
    name: "fake",
    extractHits(_tool, payload) {
      const hits: ColumnHit[] = [];
      const rows = (payload as { rows?: Record<string, string>[] }).rows ?? [];
      rows.forEach((row, i) => {
        for (const [k, v] of Object.entries(row)) {
          if (/\[.+\]$/.test(k) && typeof v === "string") {
            hits.push({ columnKey: k, value: v, rowId: `r${i}` });
          }
        }
      });
      return hits;
    },
  };
  return { pipeline: new MaskingPipeline(cfg, store, adapter), store };
}

test("masks tagged column values consistently", () => {
  const { pipeline } = makePipeline();
  const result = pipeline.maskResult("query", {
    rows: [
      { "Customer[Customer Name]": "Contoso Ltd", "Sales[Amount]": "100" },
      { "Customer[Customer Name]": "Fabrikam Inc", "Sales[Amount]": "200" },
      { "Customer[Customer Name]": "Contoso Ltd", "Sales[Amount]": "300" },
    ],
  });
  const text = JSON.stringify(result);
  assert.ok(text.includes("Client 1"));
  assert.ok(text.includes("Client 2"));
  for (const v of SENSITIVE) assert.ok(!text.includes(v), `leaked: ${v}`);
  // Grouping preserved: Contoso appears twice as the same token.
  assert.equal((text.match(/Client 1/g) ?? []).length, 2);
});

test("linkTo gives related columns the same entity index", () => {
  const { pipeline } = makePipeline();
  const result = pipeline.maskResult("query", {
    rows: [{ "Customer[Customer Name]": "Contoso Ltd", "Customer[Email]": "info@contoso.com" }],
  });
  const text = JSON.stringify(result);
  assert.ok(text.includes("Client 1"));
  assert.ok(text.includes("client1@masked.example"));
});

test("global sweep catches known values outside tagged columns (error messages, expressions)", () => {
  const { pipeline } = makePipeline();
  // Value learned with column context first…
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] });
  // …then appears in free text with no column context at all.
  const masked = pipeline.maskText("Query failed: filter on 'Contoso Ltd' returned no rows");
  assert.ok(!masked.includes("Contoso Ltd"));
  assert.ok(masked.includes("Client 1"));
});

test("inbound args are unmasked so filters work upstream", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] });
  const args = pipeline.unmaskArgs({
    request: { query: 'FILTER(Customer, Customer[Customer Name] = "Client 1")' },
  });
  assert.ok(JSON.stringify(args).includes("Contoso Ltd"));
});

test("unknown tokens fail closed", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] });
  assert.throws(
    () => pipeline.unmaskArgs({ request: { query: 'filter = "Client 99"' } }),
    UnknownTokenError,
  );
});

test('"Client 1" never matches inside "Client 12"', () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] }); // Client 1
  // "Client 12" is unknown → must error, not partially substitute.
  assert.throws(() => pipeline.unmaskArgs({ q: 'x = "Client 12"' }), UnknownTokenError);
});

test("LEAK TEST: no known sensitive value survives anywhere in a deeply nested result", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", {
    rows: [
      { "Customer[Customer Name]": "Contoso Ltd" },
      { "Customer[Customer Name]": "Fabrikam Inc" },
      { "Customer[Customer Name]": "Adventure Works" },
    ],
  });
  const nasty = {
    content: [
      { type: "text", text: JSON.stringify({ stats: { topValue: "Adventure Works" } }) },
      { type: "text", text: "Measure: IF([Client]=\"Contoso Ltd\", 1, 0) // Fabrikam Inc note" },
    ],
    structuredContent: { sample: ["Contoso Ltd", { deep: { deeper: "Fabrikam Inc" } }] },
    isError: false,
  };
  const masked = JSON.stringify(pipeline.maskResult("anything", nasty));
  for (const v of SENSITIVE.slice(0, 3)) assert.ok(!masked.includes(v), `leaked: ${v}`);
});

test("excluded values are never registered or swept", () => {
  const cfg = ConfigSchema.parse({
    columns: [
      { match: "Customer[Customer Name]", mask: "token", prefix: "Client", exclude: ["UNKNOWN", "n/a"] },
    ],
  });
  const store = new MappingStore(join(mkdtempSync(join(tmpdir(), "maskmcp-")), "map.jsonl"), {
    mode: "sequential",
  });
  const adapter: SourceAdapter = {
    name: "fake",
    extractHits(_tool, payload) {
      const hits: ColumnHit[] = [];
      const rows = (payload as { rows?: Record<string, string>[] }).rows ?? [];
      rows.forEach((row, i) => {
        for (const [k, v] of Object.entries(row)) {
          if (/\[.+\]$/.test(k)) hits.push({ columnKey: k, value: v, rowId: `r${i}` });
        }
      });
      return hits;
    },
  };
  const pipeline = new MaskingPipeline(cfg, store, adapter);

  const masked = pipeline.maskResult("query", {
    rows: [
      { "Customer[Customer Name]": "Contoso Ltd" },
      { "Customer[Customer Name]": "UNKNOWN" },
      { "Customer[Customer Name]": "N/A" }, // case-insensitive exclusion
    ],
  });
  const text = JSON.stringify(masked);
  assert.ok(text.includes("Client 1"), "real value masked");
  assert.ok(text.includes("UNKNOWN"), "excluded value passes through");
  assert.ok(text.includes("N/A"), "exclusion is case-insensitive");
  assert.equal(store.count(), 1, "only the real value registered");

  // Even if an excluded value somehow lands in the store (e.g. registered
  // before the exclusion was added), the sweep must not mask it.
  store.getOrCreateToken("customer[customer name]", "Client", "token", "UNKNOWN");
  const after = pipeline.maskText("status is UNKNOWN for Contoso Ltd");
  assert.ok(after.includes("UNKNOWN"), "pre-existing mapping for excluded value not swept");
  assert.ok(!after.includes("Contoso Ltd"));
});

test("case-variant appearances of known values are masked (UPPER'd measure output)", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] }); // Client 1
  const masked = pipeline.maskText("Top customer: CONTOSO LTD (also contoso ltd, CoNtOsO lTd)");
  assert.ok(!/contoso/i.test(masked), "no case variant may survive");
  assert.equal((masked.match(/Client 1/g) ?? []).length, 3, "all variants get the canonical token");
  // Inbound unmasking still emits the canonical-case real value.
  const args = pipeline.unmaskArgs({ q: 'name = "Client 1"' });
  assert.ok(JSON.stringify(args).includes("Contoso Ltd"));
});

test("values differing only by case keep their own tokens on exact match", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", {
    rows: [{ "Customer[Customer Name]": "Contoso Ltd" }, { "Customer[Customer Name]": "CONTOSO LTD" }],
  }); // Client 1, Client 2
  const masked = pipeline.maskText("a: Contoso Ltd, b: CONTOSO LTD, c: cOnToSo LtD");
  assert.ok(masked.includes("a: Client 1"), "exact case → its own token");
  assert.ok(masked.includes("b: Client 2"), "exact case → its own token");
  assert.ok(!/contoso/i.test(masked), "unseen case variant still masked (canonical fallback)");
});

test("stale tokens still unmask and report their rename", () => {
  const { pipeline, store } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "Contoso Ltd" }] }); // Client 1
  // Data owner renames the token (prefix re-token or manual rename).
  store.assignToken("customer[customer name]", "Customer", "Contoso Ltd", "Customer 1");

  // Old token: translates correctly AND reports the rename.
  const tracked = pipeline.unmaskArgsTracked({ q: 'name = "Client 1"' });
  assert.ok(JSON.stringify(tracked.args).includes("Contoso Ltd"), "stale token still translates");
  assert.deepEqual(tracked.renames, [{ from: "Client 1", to: "Customer 1" }]);

  // Current token: no rename notice.
  const current = pipeline.unmaskArgsTracked({ q: 'name = "Customer 1"' });
  assert.ok(JSON.stringify(current.args).includes("Contoso Ltd"));
  assert.deepEqual(current.renames, []);

  // Outbound masking emits the new token.
  assert.ok(pipeline.maskText("for Contoso Ltd").includes("Customer 1"));
});

test("seed groups: bracket-less rules mask, fail closed, and skip warm-up", () => {
  // The UI's manual warm-up registers values under `seed:<label>` rules.
  const cfg = ConfigSchema.parse({
    columns: [{ match: "seed:customers", prefix: "Client" }],
  });
  const store = new MappingStore(join(mkdtempSync(join(tmpdir(), "maskmcp-")), "map.jsonl"), {
    mode: "sequential",
  });
  const pipeline = new MaskingPipeline(cfg, store, undefined);
  store.getOrCreateToken("seed:customers", "Client", "token", "Contoso Ltd");

  assert.ok(pipeline.maskText("report for Contoso Ltd").includes("Client 1"), "sweep masks seeded values");
  assert.ok(
    JSON.stringify(pipeline.unmaskArgs({ q: 'name = "Client 1"' })).includes("Contoso Ltd"),
    "seeded tokens unmask inbound",
  );
  assert.throws(
    () => pipeline.unmaskArgs({ q: 'name = "Client 99"' }),
    UnknownTokenError,
    "seed prefixes are known token shapes — unknown tokens still fail closed",
  );
  assert.equal(pipeline.warmupRules().length, 0, "seed rules are never warm-up scanned");
});

test("short values are masked with word boundaries, not substring-replaced", () => {
  const { pipeline } = makePipeline();
  pipeline.maskResult("query", { rows: [{ "Customer[Customer Name]": "AB" }] }); // Client 1
  const masked = pipeline.maskText("ABSOLUTE values for AB and ABS");
  assert.ok(masked.includes("ABSOLUTE"), "must not corrupt words containing the short value");
  assert.ok(masked.includes("ABS"), "must not corrupt words containing the short value");
  assert.ok(masked.includes("Client 1"), "standalone short value still masked");
  assert.ok(!/\bAB\b/.test(masked), "standalone short value must not survive");
});
