import type { MappingStore } from "./store.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Recursively map every string in a JSON-safe structure. */
export function deepMapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, fn)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepMapStrings(v, fn);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * The safety net. Replaces every known sensitive value (mask direction) or
 * every known token (unmask direction) in arbitrary text — error messages,
 * DAX/M expressions, statistics, anywhere. Longest-match-first so
 * overlapping values resolve correctly.
 */
export class Sweeper {
  private maskRe: RegExp | null = null;
  private maskMap = new Map<string, string>();
  private unmaskRe: RegExp | null = null;
  private unmaskMap = new Map<string, string>();
  private builtAt = -1;

  constructor(
    private store: MappingStore,
    /** Lower-cased values that must never be masked (config exclude lists). */
    private excludedLower: Set<string> = new Set(),
  ) {}

  maskText(s: string): string {
    this.rebuildIfStale();
    if (!this.maskRe) return s;
    return s.replace(this.maskRe, (m) => this.maskMap.get(m) ?? m);
  }

  unmaskText(s: string): string {
    this.rebuildIfStale();
    if (!this.unmaskRe) return s;
    return s.replace(this.unmaskRe, (m) => this.unmaskMap.get(m) ?? m);
  }

  deepMask<T>(value: T): T {
    return deepMapStrings(value, (s) => this.maskText(s));
  }

  deepUnmask<T>(value: T): T {
    return deepMapStrings(value, (s) => this.unmaskText(s));
  }

  private rebuildIfStale(): void {
    this.store.refresh();
    if (this.builtAt === this.store.version) return;
    this.builtAt = this.store.version;

    const pairs = this.store.allTokens();
    this.maskMap.clear();
    this.unmaskMap.clear();
    for (const { token, value } of pairs) {
      if (value.length > 0 && !this.excludedLower.has(value.toLowerCase())) {
        this.maskMap.set(value, token);
      }
      // Tokens always unmask, even for excluded values (harmless and lossless).
      this.unmaskMap.set(token, value);
    }

    // Mask direction: plain substring match — over-masking is the safe
    // direction. Unmask direction: word boundaries so "Client 1" never
    // matches inside "Client 12".
    this.maskRe = buildAlternation([...this.maskMap.keys()], false);
    this.unmaskRe = buildAlternation([...this.unmaskMap.keys()], true);
  }
}

function buildAlternation(literals: string[], boundaries: boolean): RegExp | null {
  if (literals.length === 0) return null;
  const sorted = [...literals].sort((a, b) => b.length - a.length);
  // Short values (< 4 chars) always get word boundaries: substring-replacing
  // a 2-char client code would corrupt every word containing those letters.
  const parts = sorted.map((l) =>
    boundaries || l.length < 4 ? `\\b${escapeRegex(l)}\\b` : escapeRegex(l),
  );
  return new RegExp(parts.join("|"), "g");
}
