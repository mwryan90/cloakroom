import type { ColumnHit, SourceAdapter } from "./adapter.js";
import type { CompiledRule, MaskConfig } from "./config.js";
import { RuleMatcher } from "./config.js";
import type { MappingStore } from "./store.js";
import { Sweeper } from "./sweep.js";

export class UnknownTokenError extends Error {
  constructor(public tokens: string[]) {
    super(
      `Unknown masked token(s): ${tokens.join(", ")}. ` +
        "These do not correspond to any known value. Use tokens exactly as they appeared in earlier results.",
    );
    this.name = "UnknownTokenError";
  }
}

export class MaskingPipeline {
  sweeper: Sweeper;
  private matcher: RuleMatcher;
  /** Regexes that recognize token *shapes* per rule, to catch unknown tokens inbound. */
  private tokenShapes: RegExp[];

  private excluded: Set<string>;

  constructor(
    private cfg: MaskConfig,
    private store: MappingStore,
    private adapter?: SourceAdapter,
  ) {
    this.matcher = new RuleMatcher(cfg.columns);
    this.excluded = new Set(
      cfg.columns.flatMap((c) => (c.exclude ?? []).map((v) => v.toLowerCase())),
    );
    this.sweeper = new Sweeper(store, this.excluded);
    this.tokenShapes = this.matcher.compiled.map((c) => tokenShapeRegex(c));
  }

  /** Hot-reload: apply a freshly parsed config to the running pipeline. */
  updateConfig(cfg: MaskConfig): void {
    this.cfg = cfg;
    this.matcher = new RuleMatcher(cfg.columns);
    this.excluded = new Set(
      cfg.columns.flatMap((c) => (c.exclude ?? []).map((v) => v.toLowerCase())),
    );
    this.sweeper = new Sweeper(this.store, this.excluded);
    this.tokenShapes = this.matcher.compiled.map((c) => tokenShapeRegex(c));
  }

  get config(): MaskConfig {
    return this.cfg;
  }

  /**
   * Outbound: register newly seen values from tagged columns (adapter), then
   * sweep-replace every known sensitive value anywhere in the result.
   */
  maskResult<T>(toolName: string, result: T): T {
    if (this.adapter) {
      try {
        this.registerHits(this.adapter.extractHits(toolName, result));
      } catch {
        // Registration is best-effort; the sweep below still runs.
      }
    }
    return this.sweeper.deepMask(result);
  }

  /** Mask free text (error messages, log lines). */
  maskText(s: string): string {
    return this.sweeper.maskText(s);
  }

  /**
   * Inbound: replace known tokens in tool arguments with real values, then
   * fail closed if anything that *looks* like a token remains.
   */
  unmaskArgs<T>(args: T): T {
    const out = this.sweeper.deepUnmask(args);
    const leftovers = new Set<string>();
    collectStrings(out, (s) => {
      for (const re of this.tokenShapes) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s)) !== null) leftovers.add(m[0]);
      }
    });
    if (leftovers.size > 0) throw new UnknownTokenError([...leftovers]);
    return out;
  }

  /** Register values discovered with column context (adapter or warm-up). */
  registerHits(hits: ColumnHit[]): void {
    // Group by row so linkTo can resolve within-row.
    const byRow = new Map<string, ColumnHit[]>();
    for (const h of hits) {
      const key = h.rowId ?? `__solo_${Math.random()}`;
      const arr = byRow.get(key) ?? [];
      arr.push(h);
      byRow.set(key, arr);
    }
    for (const row of byRow.values()) {
      for (const hit of row) {
        const compiled = this.matcher.matchKey(hit.columnKey);
        if (!compiled || typeof hit.value !== "string" || hit.value.length === 0) continue;
        if (this.excluded.has(hit.value.toLowerCase())) continue;
        let linkedSeq: number | undefined;
        if (compiled.rule.linkTo) {
          linkedSeq = this.resolveLinkedSeq(compiled, row);
        }
        this.store.getOrCreateToken(
          compiled.groupId,
          compiled.rule.prefix,
          compiled.rule.mask,
          hit.value,
          linkedSeq,
        );
      }
    }
  }

  registerWarmupValues(rule: CompiledRule, values: string[]): void {
    for (const v of values) {
      if (typeof v !== "string" || v.length === 0) continue;
      if (this.excluded.has(v.toLowerCase())) continue;
      this.store.getOrCreateToken(rule.groupId, rule.rule.prefix, rule.rule.mask, v);
    }
  }

  /** Rules eligible for warm-up scans (concrete table[column], no wildcard). */
  warmupRules(): CompiledRule[] {
    return this.matcher.compiled.filter((c) => c.concrete !== undefined);
  }

  isWriteCall(toolName: string, args: unknown): boolean {
    return this.cfg.readOnly && (this.adapter?.isWriteCall?.(toolName, args) ?? false);
  }

  private resolveLinkedSeq(compiled: CompiledRule, row: ColumnHit[]): number | undefined {
    const target = this.matcher.byMatchString(compiled.rule.linkTo!);
    if (!target) return undefined;
    const linkedHit = row.find((h) => this.matcher.matchKey(h.columnKey)?.groupId === target.groupId);
    if (!linkedHit) return undefined;
    // Ensure the linked value has a token, then reuse its index.
    this.store.getOrCreateToken(target.groupId, target.rule.prefix, target.rule.mask, linkedHit.value);
    return this.store.lookupByValue(target.groupId, linkedHit.value)?.seq;
  }
}

function tokenShapeRegex(c: CompiledRule): RegExp {
  const prefix = c.rule.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (c.rule.mask === "email") {
    return new RegExp(`\\b${prefix.toLowerCase()}_?[a-z0-9]+@masked\\.example\\b`, "gi");
  }
  // Matches "Client 12" (sequential) and "Client_a3f9e2" (hmac).
  return new RegExp(`\\b${prefix}(?: \\d+|_[0-9a-f]{6,})\\b`, "g");
}

function collectStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, fn));
  else if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, fn));
  }
}
