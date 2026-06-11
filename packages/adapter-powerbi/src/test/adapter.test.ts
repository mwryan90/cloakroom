import assert from "node:assert/strict";
import test from "node:test";
import { powerBiAdapter } from "../index.js";

// Exact shape observed live from powerbi-modeling-mcp (DAX results arrive as
// CSV, usually inside a resource content block).
const REAL_SHAPE_RESULT = {
  content: [
    { type: "text", text: '{"success":true}' },
    {
      type: "resource",
      resource: {
        uri: "file:///C:/Users/x/AppData/Local/Temp/PowerBIModelingMCP/QueryResults/dax_query_result_1.csv",
        mimeType: "text/csv",
        text: [
          "DimCustomer[CustomerName],DimCustomer[TradingName],[Total]",
          "Contoso Ltd,Contoso Ltd,1234567.89",
          'Fabrikam Inc,"Fabrikam, Inc",987654.32',
        ].join("\n"),
      },
    },
  ],
};

test("extracts hits from real CSV resource shape", () => {
  const hits = powerBiAdapter.extractHits("dax_query_operations", REAL_SHAPE_RESULT);
  const names = hits.filter((h) => h.columnKey === "DimCustomer[CustomerName]").map((h) => h.value);
  assert.deepEqual(names, ["Contoso Ltd", "Fabrikam Inc"]);
  // Quoted field with comma parsed correctly:
  const trading = hits.filter((h) => h.columnKey === "DimCustomer[TradingName]").map((h) => h.value);
  assert.deepEqual(trading, ["Contoso Ltd", "Fabrikam, Inc"]);
  // Same row → same rowId (for linkTo); includes the [Total] measure cell:
  const row0 = hits.filter((h) => h.rowId === hits[0].rowId);
  assert.equal(row0.length, 3);
});

test("parses warm-up VALUES() CSV result", () => {
  const payload = {
    content: [
      { type: "text", text: '{"success":true}' },
      {
        type: "resource",
        resource: {
          uri: "file:///tmp/r.csv",
          mimeType: "text/csv",
          text: "DimCustomer[CustomerName]\nContoso Ltd\nFabrikam Inc\nUNKNOWN",
        },
      },
    ],
  };
  const values = powerBiAdapter.parseWarmupValues!(payload, {
    table: "DimCustomer",
    column: "CustomerName",
  });
  assert.deepEqual(values.sort(), ["Fabrikam Inc", "UNKNOWN", "Contoso Ltd"].sort());
});

test("still extracts hits from JSON row shapes", () => {
  const payload = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ rows: [{ "'Customer'[Customer Name]": "Contoso Ltd" }] }),
      },
    ],
  };
  const hits = powerBiAdapter.extractHits("dax_query_operations", payload);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, "Contoso Ltd");
});

test("write detection by operation", () => {
  assert.ok(powerBiAdapter.isWriteCall!("column_operations", { request: { operation: "Update" } }));
  assert.ok(!powerBiAdapter.isWriteCall!("dax_query_operations", { request: { operation: "Execute" } }));
});
