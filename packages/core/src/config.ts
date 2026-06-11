import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const ColumnRuleSchema = z.object({
  /** `Table[Column]` pattern; `*` wildcards allowed in either part. */
  match: z.string().min(1),
  mask: z.enum(["token", "email"]).default("token"),
  prefix: z.string().min(1).default("Value"),
  /** match-string of another rule; same entity gets the same index. */
  linkTo: z.string().optional(),
  /** Values that should NOT be masked (placeholders like "UNKNOWN", "N/A"). Case-insensitive. */
  exclude: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  mappingStore: z.string().default("./masking-map.jsonl"),
  tokenMode: z.enum(["sequential", "hmac"]).default("sequential"),
  hmacSecretEnv: z.string().default("MASK_TEAM_SECRET"),
  warmup: z.boolean().default(true),
  /** Which Power BI Desktop window to attach to when several are open (substring match on the window title). */
  model: z.string().optional(),
  readOnly: z.boolean().default(false),
  /** Columns whose "suggested" flag was dismissed as a false positive in the UI. */
  dismissed: z.array(z.string()).default([]),
  columns: z.array(ColumnRuleSchema).min(1),
});

export type ColumnRule = z.infer<typeof ColumnRuleSchema>;
export type MaskConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath: string): MaskConfig {
  const raw = readFileSync(configPath, "utf8");
  const cfg = ConfigSchema.parse(parse(raw));
  cfg.mappingStore = resolve(dirname(resolve(configPath)), cfg.mappingStore);
  return cfg;
}

/** Normalize a column key: strip quotes, lowercase. `'Customer'[Name]` → `customer[name]` */
export function normalizeColumnKey(key: string): string {
  return key.replace(/'/g, "").trim().toLowerCase();
}

export interface CompiledRule {
  rule: ColumnRule;
  /** Stable group id for the mapping store. */
  groupId: string;
  regex: RegExp;
  /** Parsed table/column if the pattern has no wildcards (warm-up eligible). */
  concrete?: { table: string; column: string };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileRules(rules: ColumnRule[]): CompiledRule[] {
  return rules.map((rule) => {
    const norm = normalizeColumnKey(rule.match);
    const pattern = "^" + escapeRegex(norm).replace(/\\\*/g, ".*") + "$";
    let concrete: { table: string; column: string } | undefined;
    if (!rule.match.includes("*")) {
      const m = /^'?([^'[\]]+)'?\[([^\]]+)\]$/.exec(rule.match.trim());
      if (m) concrete = { table: m[1], column: m[2] };
    }
    return { rule, groupId: norm, regex: new RegExp(pattern), concrete };
  });
}

export class RuleMatcher {
  readonly compiled: CompiledRule[];

  constructor(rules: ColumnRule[]) {
    this.compiled = compileRules(rules);
  }

  matchKey(columnKey: string): CompiledRule | undefined {
    const norm = normalizeColumnKey(columnKey);
    return this.compiled.find((c) => c.regex.test(norm));
  }

  byMatchString(match: string): CompiledRule | undefined {
    const norm = normalizeColumnKey(match);
    return this.compiled.find((c) => c.groupId === norm);
  }
}
