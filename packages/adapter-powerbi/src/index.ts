import type {
  ColumnHit,
  ColumnInfo,
  ColumnRef,
  ColumnSamples,
  SourceAdapter,
  ToolCaller,
  WarmupCall,
} from "cloakroom-core";
import { normalizeColumnKey } from "cloakroom-core";

/**
 * Adapter for Microsoft's powerbi-modeling-mcp server.
 *
 * DAX result sets carry fully qualified column keys like
 * `Customer[Customer Name]` or `'Customer'[Customer Name]` — we use those as
 * column context. Results arrive either as JSON inside text content blocks or
 * (observed live) as CSV inside resource content blocks, so strings are
 * parsed both ways.
 */

const COLUMN_KEY_RE = /^'?[^'[\]]*'?\[[^\]]+\]$/;

/** Operations that mutate the model (used by readOnly mode). */
const WRITE_OPERATIONS = new Set([
  "create",
  "update",
  "delete",
  "rename",
  "createorreplace",
  "deploy",
  "process",
  "commit",
]);

export const powerBiAdapter: SourceAdapter = {
  name: "powerbi",

  extractHits(_toolName: string, payload: unknown): ColumnHit[] {
    const hits: ColumnHit[] = [];
    const counter = { n: 0 };
    walk(payload, hits, counter, 0);
    return hits;
  },

  /**
   * Connect to a local Power BI Desktop instance. With several models open,
   * `modelHint` (config key `model:`) selects by window title; otherwise the
   * first instance is used and the alternatives are reported.
   */
  async listModels(call: ToolCaller): Promise<string[]> {
    return (await listInstances(call)).map((i) => i.title);
  },

  async prepare(call: ToolCaller, modelHint?: string): Promise<string> {
    const instances = await listInstances(call);
    if (instances.length === 0) {
      throw new Error(
        "No local Power BI Desktop instance found. Open your model in Power BI Desktop, then try again.",
      );
    }

    let chosen = instances[0];
    if (modelHint) {
      const hit = instances.find((i) => i.title.toLowerCase().includes(modelHint.toLowerCase()));
      if (!hit) {
        throw new Error(
          `No open Power BI Desktop window matches model "${modelHint}". ` +
            `Open windows: ${instances.map((i) => i.title).join(", ")}`,
        );
      }
      chosen = hit;
    }

    const connect = await call("connection_operations", {
      request: { operation: "Connect", connectionString: chosen.connectionString },
    });
    if ((connect as { isError?: boolean }).isError) {
      throw new Error(`Failed to connect to ${chosen.title}`);
    }
    const others = instances.filter((i) => i !== chosen).map((i) => i.title);
    return (
      `connected to ${chosen.title}` +
      (others.length > 0 && !modelHint
        ? ` (also open: ${others.join(", ")} — set "model:" in masking.yaml to pick a specific one)`
        : "")
    );
  },

  warmupCall(column: ColumnRef): WarmupCall {
    const table = column.table.replace(/'/g, "''");
    const col = column.column.replace(/]/g, "]]");
    return {
      tool: "dax_query_operations",
      args: {
        request: {
          operation: "Execute",
          query: `EVALUATE VALUES('${table}'[${col}])`,
          maxRows: 1000000,
        },
      },
    };
  },

  parseWarmupValues(payload: unknown, column: ColumnRef): string[] {
    const hits = powerBiAdapter.extractHits("dax_query_operations", payload);
    const wantSuffix = `[${column.column.toLowerCase()}]`;
    const values = new Set<string>();
    for (const h of hits) {
      if (normalizeColumnKey(h.columnKey).endsWith(wantSuffix)) values.add(h.value);
    }
    return [...values];
  },

  isWriteCall(_toolName: string, args: unknown): boolean {
    const op = (args as { request?: { operation?: unknown } } | undefined)?.request?.operation;
    return typeof op === "string" && WRITE_OPERATIONS.has(op.toLowerCase());
  },

  async listColumns(call: ToolCaller): Promise<ColumnInfo[]> {
    const res = await call("column_operations", {
      request: { operation: "List", filter: { maxResults: 100000 } },
    });
    const out: ColumnInfo[] = [];
    for (const obj of collectJsonObjects(res)) {
      const data = (obj as { data?: unknown }).data;
      if (!Array.isArray(data)) continue;
      for (const t of data) {
        const tableName = (t as { tableName?: unknown }).tableName;
        const columns = (t as { columns?: unknown }).columns;
        if (typeof tableName !== "string" || !Array.isArray(columns)) continue;
        for (const c of columns) {
          const name = (c as { name?: unknown }).name;
          const dataType = (c as { dataType?: unknown }).dataType;
          if (typeof name === "string") {
            out.push({
              table: tableName,
              column: name,
              dataType: typeof dataType === "string" ? dataType : undefined,
            });
          }
        }
      }
    }
    return out;
  },

  async columnSamples(call: ToolCaller, column: ColumnRef, limit: number): Promise<ColumnSamples> {
    const table = column.table.replace(/'/g, "''");
    const colRef = `'${table}'[${column.column.replace(/]/g, "]]")}]`;
    let distinctCount: number | undefined;
    try {
      const dc = await call("dax_query_operations", {
        request: {
          operation: "Execute",
          query: `EVALUATE ROW("DistinctCount", DISTINCTCOUNT(${colRef}))`,
          maxRows: 2,
        },
      });
      const hit = powerBiAdapter
        .extractHits("dax_query_operations", dc)
        .find((h) => normalizeColumnKey(h.columnKey).includes("distinctcount"));
      if (hit) {
        const n = Number(hit.value);
        if (Number.isFinite(n)) distinctCount = n;
      }
    } catch {
      /* count unavailable — leave undefined */
    }
    const tv = await call("dax_query_operations", {
      request: {
        operation: "Execute",
        query: `EVALUATE TOPN(${limit}, VALUES(${colRef}))`,
        maxRows: limit + 1,
      },
    });
    const values = powerBiAdapter.parseWarmupValues!(tv, column);
    return { distinctCount, values };
  },
};

function walk(node: unknown, hits: ColumnHit[], counter: { n: number }, depth: number): void {
  if (depth > 32) return;
  if (typeof node === "string") {
    const t = node.trim();
    if (t.startsWith("{") || (t.startsWith("[") && !COLUMN_KEY_RE.test(firstCsvCell(t)))) {
      try {
        walk(JSON.parse(t), hits, counter, depth + 1);
        return;
      } catch {
        /* not JSON — try CSV below */
      }
    }
    // The real powerbi-modeling-mcp returns DAX results as CSV (often via a
    // resource block): header cells are column keys like DimCustomer[CustomerName].
    extractCsvHits(node, hits, counter);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, hits, counter, depth + 1);
    return;
  }
  if (node !== null && typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    const colEntries = entries.filter(([k]) => COLUMN_KEY_RE.test(k));
    if (colEntries.length > 0) {
      const rowId = `row_${counter.n++}`;
      for (const [k, v] of colEntries) {
        if (typeof v === "string") hits.push({ columnKey: k, value: v, rowId });
      }
    }
    for (const [, v] of entries) walk(v, hits, counter, depth + 1);
  }
}

/**
 * Parse CSV text whose header cells are column keys, e.g.
 *   DimCustomer[CustomerName],DimCustomer[TradingName],[Total]
 *   Contoso Ltd,Contoso Ltd,1234567.89
 * (Observed shape of powerbi-modeling-mcp DAX query results.)
 */
function extractCsvHits(text: string, hits: ColumnHit[], counter: { n: number }): void {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return;
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const colIdx = header.map((h, i) => (COLUMN_KEY_RE.test(h) ? i : -1)).filter((i) => i >= 0);
  if (colIdx.length === 0) return;
  for (let li = 1; li < lines.length; li++) {
    if (!lines[li].trim()) continue;
    const cells = parseCsvLine(lines[li]);
    const rowId = `csv_${counter.n++}`;
    for (const i of colIdx) {
      const v = cells[i];
      if (typeof v === "string" && v.length > 0) {
        hits.push({ columnKey: header[i], value: v, rowId });
      }
    }
  }
}

/** Minimal RFC-4180 line parser (quoted fields, escaped quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function firstCsvCell(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return (parseCsvLine(firstLine)[0] ?? "").trim();
}

/** Collect every JSON object parseable from any string in the payload. */
function collectJsonObjects(node: unknown, depth = 0): unknown[] {
  if (depth > 16) return [];
  if (typeof node === "string") {
    const t = node.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return [JSON.parse(t)];
      } catch {
        return [];
      }
    }
    return [];
  }
  if (Array.isArray(node)) return node.flatMap((n) => collectJsonObjects(n, depth + 1));
  if (node !== null && typeof node === "object") {
    return [node, ...Object.values(node).flatMap((n) => collectJsonObjects(n, depth + 1))];
  }
  return [];
}

interface PbiInstance {
  connectionString: string;
  title: string;
}

async function listInstances(call: ToolCaller): Promise<PbiInstance[]> {
  const res = await call("connection_operations", {
    request: { operation: "ListLocalInstances" },
  });
  const instances: PbiInstance[] = [];
  for (const obj of collectJsonObjects(res)) {
    const data = (obj as { data?: unknown }).data;
    if (!Array.isArray(data)) continue;
    for (const d of data) {
      const cs = (d as { connectionString?: unknown }).connectionString;
      if (typeof cs !== "string") continue;
      const t = (d as { parentWindowTitle?: unknown }).parentWindowTitle;
      instances.push({ connectionString: cs, title: typeof t === "string" ? t : cs });
    }
  }
  return instances;
}
