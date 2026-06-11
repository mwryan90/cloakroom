/**
 * The adapter interface — everything source-server-specific lives behind this.
 * The core works with no adapter at all (global sweep only, mappings seeded
 * externally); an adapter adds column-aware discovery and warm-up scans.
 */

export interface ColumnRef {
  table: string;
  column: string;
}

export interface ColumnInfo extends ColumnRef {
  dataType?: string;
}

/** A sensitive-candidate value found in a tool result, with column context. */
export interface ColumnHit {
  /** Raw column key as it appeared, e.g. `Customer[Customer Name]`. */
  columnKey: string;
  value: string;
  /** Opaque row identity so hits from the same row can be linked (linkTo). */
  rowId?: string;
}

export interface WarmupCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Calls a tool on the (already connected) upstream server. */
export type ToolCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ColumnSamples {
  distinctCount?: number;
  values: string[];
}

export interface SourceAdapter {
  name: string;

  /** Find values-with-column-context in a tool result payload. */
  extractHits(toolName: string, payload: unknown): ColumnHit[];

  /**
   * One-time session preparation (e.g. connect to a local Power BI Desktop
   * instance). Returns a human-readable status. Throwing is non-fatal for the
   * proxy (warm-up degrades) but surfaces as an error in the admin UI.
   */
  prepare?(call: ToolCaller, modelHint?: string): Promise<string | void>;

  /** Titles of all locally available models/instances (for multi-model warm-up and the UI switcher). */
  listModels?(call: ToolCaller): Promise<string[]>;

  /** Build the upstream tool call that enumerates distinct values of a column. */
  warmupCall?(column: ColumnRef): WarmupCall | null;

  /** Extract the distinct values from a warm-up call's result. */
  parseWarmupValues?(payload: unknown, column: ColumnRef): string[];

  /** True if this call would mutate the source (used by readOnly mode). */
  isWriteCall?(toolName: string, args: unknown): boolean;

  /** Schema discovery (used by the admin UI). */
  listColumns?(call: ToolCaller): Promise<ColumnInfo[]>;

  /** Distinct count + up to `limit` sample values (used by the admin UI). */
  columnSamples?(call: ToolCaller, column: ColumnRef, limit: number): Promise<ColumnSamples>;
}
