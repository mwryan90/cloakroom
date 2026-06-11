import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";

export type TokenMode = "sequential" | "hmac";
export type MaskKind = "token" | "email";

export interface StoreOptions {
  mode: TokenMode;
  /** Required when mode === "hmac". */
  hmacSecret?: string;
}

export interface Mapping {
  token: string;
  seq: number;
}

interface Record_ {
  g: string; // column group
  v: string; // real value
  t: string; // token
  s: number; // seq (-1 in hmac mode)
  p: string; // prefix (to rebuild counters)
}

/**
 * Bidirectional, persistent value↔token map backed by an append-only JSONL
 * file. No native dependencies. This file IS the secret: it stays local and
 * its contents are never written to the MCP transport.
 */
export class MappingStore {
  private byValue = new Map<string, Mapping>(); // `${group}${value}`
  private byToken = new Map<string, string>(); // token -> real value
  private counters = new Map<string, number>(); // prefix -> next seq
  /** Bumped on every insert so regex caches can invalidate. */
  version = 0;

  private mode: TokenMode;
  private secret?: string;
  private loadedBytes = 0;
  private lastRefreshCheck = 0;

  constructor(
    private filePath: string,
    opts: StoreOptions,
  ) {
    this.mode = opts.mode;
    this.secret = opts.hmacSecret;
    if (this.mode === "hmac" && !this.secret) {
      throw new Error("hmac token mode requires a team secret");
    }
    this.load();
  }

  /**
   * Pick up records appended by OTHER processes sharing this file (the admin
   * UI and the proxy can run at the same time). Throttled stat() check;
   * append-only format makes a full re-read idempotent.
   */
  refresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastRefreshCheck < 150) return;
    this.lastRefreshCheck = now;
    try {
      if (!existsSync(this.filePath)) return;
      const size = statSync(this.filePath).size;
      if (size !== this.loadedBytes) this.load();
    } catch {
      /* stat raced with writer — next call will retry */
    }
  }

  lookupByValue(group: string, value: string): Mapping | undefined {
    this.refresh();
    return this.byValue.get(key(group, value));
  }

  lookupByToken(token: string): string | undefined {
    this.refresh();
    return this.byToken.get(token);
  }

  /**
   * Get or create the token for a value.
   * `linkedSeq` reuses an existing index so related columns (e.g. an email
   * column linked to a name column) share the same entity number.
   */
  getOrCreateToken(
    group: string,
    prefix: string,
    mask: MaskKind,
    value: string,
    linkedSeq?: number,
  ): string {
    // Unthrottled refresh before allocating: shrinks the cross-process race
    // window to the stat→append gap (new-value allocation is rare).
    this.refresh(true);
    const existing = this.byValue.get(key(group, value));
    if (existing) return existing.token;

    let seq: number;
    let token: string;
    if (this.mode === "hmac") {
      seq = -1;
      token = this.hmacToken(prefix, mask, value);
      if (this.byToken.has(token)) token = this.hmacToken(prefix, mask, value, 16);
    } else {
      seq = linkedSeq !== undefined && linkedSeq >= 0 ? linkedSeq : this.nextSeq(prefix);
      token = formatToken(prefix, mask, seq);
      // Collision (e.g. linked seq already taken by a different value in this
      // group): fall back to a fresh sequential token.
      while (this.byToken.has(token)) {
        seq = this.nextSeq(prefix);
        token = formatToken(prefix, mask, seq);
      }
    }

    this.insert({ g: group, v: value, t: token, s: seq, p: prefix });
    return token;
  }

  /** All real values (for the outbound sweep). */
  allValues(): string[] {
    return [...this.byToken.values()];
  }

  /** All token/value pairs (for inbound unmasking). */
  allTokens(): { token: string; value: string }[] {
    this.refresh();
    return [...this.byToken.entries()].map(([token, value]) => ({ token, value }));
  }

  /** Full mapping rows including column group (for the admin UI's decoder). */
  allMappings(): { group: string; value: string; token: string }[] {
    this.refresh(true);
    return [...this.byValue.entries()].map(([k, m]) => {
      const i = k.indexOf("\u001f");
      return { group: k.slice(0, i), value: k.slice(i + 1), token: m.token };
    });
  }

  count(): number {
    return this.byToken.size;
  }

  close(): void {
    /* nothing to do — appends are synchronous */
  }

  /**
   * Explicitly assign (or re-assign) a token for a value — used by the admin
   * UI's manual mapping grid. Re-assignment appends a new record; the latest
   * assignment wins for masking, and older tokens still unmask correctly.
   */
  assignToken(group: string, prefix: string, value: string, token: string): void {
    if (!token || !value) throw new Error("value and token must be non-empty");
    const owner = this.byToken.get(token);
    if (owner !== undefined && owner !== value) {
      throw new Error(`token "${token}" is already assigned to a different value`);
    }
    this.insert({ g: group, v: value, t: token, s: -1, p: prefix });
  }

  private insert(r: Record_): void {
    this.byValue.set(key(r.g, r.v), { token: r.t, seq: r.s });
    this.byToken.set(r.t, r.v);
    appendFileSync(this.filePath, JSON.stringify(r) + "\n", { encoding: "utf8", mode: 0o600 });
    this.loadedBytes = statSync(this.filePath).size;
    this.version++;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const content = readFileSync(this.filePath, "utf8");
    this.loadedBytes = Buffer.byteLength(content, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let r: Record_;
      try {
        r = JSON.parse(line) as Record_;
      } catch {
        continue; // tolerate a torn final line
      }
      this.byValue.set(key(r.g, r.v), { token: r.t, seq: r.s });
      this.byToken.set(r.t, r.v);
      if (r.s >= 0) {
        const next = this.counters.get(r.p) ?? 1;
        if (r.s + 1 > next) this.counters.set(r.p, r.s + 1);
      }
    }
    this.version++;
  }

  private nextSeq(prefix: string): number {
    const n = this.counters.get(prefix) ?? 1;
    this.counters.set(prefix, n + 1);
    return n;
  }

  private hmacToken(prefix: string, mask: MaskKind, value: string, length = 8): string {
    const h = createHmac("sha256", this.secret!).update(value).digest("hex").slice(0, length);
    return mask === "email" ? `${prefix.toLowerCase()}_${h}@masked.example` : `${prefix}_${h}`;
  }
}

function key(group: string, value: string): string {
  return group + "\u001f" + value;
}

export function formatToken(prefix: string, mask: MaskKind, seq: number): string {
  return mask === "email" ? `${prefix.toLowerCase()}${seq}@masked.example` : `${prefix} ${seq}`;
}
