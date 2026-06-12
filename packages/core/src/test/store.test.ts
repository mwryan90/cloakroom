import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MappingStore } from "../store.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "maskmcp-")), "map.jsonl");
}

test("sequential tokens are stable and bidirectional", () => {
  const s = new MappingStore(tmpDb(), { mode: "sequential" });
  const t1 = s.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  const t2 = s.getOrCreateToken("g", "Client", "token", "Fabrikam Inc");
  const t1again = s.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  assert.equal(t1, "Client 1");
  assert.equal(t2, "Client 2");
  assert.equal(t1again, t1);
  assert.equal(s.lookupByToken("Client 1"), "Contoso Ltd");
  s.close();
});

test("mappings persist across reopen", () => {
  const path = tmpDb();
  const a = new MappingStore(path, { mode: "sequential" });
  a.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  a.close();
  const b = new MappingStore(path, { mode: "sequential" });
  assert.equal(b.getOrCreateToken("g", "Client", "token", "Contoso Ltd"), "Client 1");
  assert.equal(b.getOrCreateToken("g", "Client", "token", "New Co"), "Client 2");
  b.close();
});

test("renamedTo tracks supersession chains and survives reopen", () => {
  const path = tmpDb();
  const a = new MappingStore(path, { mode: "sequential" });
  a.getOrCreateToken("g", "Client", "token", "Contoso Ltd"); // Client 1
  a.assignToken("g", "Customer", "Contoso Ltd", "Customer 1");
  assert.equal(a.renamedTo("Client 1"), "Customer 1");
  assert.equal(a.renamedTo("Customer 1"), undefined, "current token is not an alias");

  // Chain: a second rename re-points the oldest alias too.
  a.assignToken("g", "Acct", "Contoso Ltd", "Acct 1");
  assert.equal(a.renamedTo("Client 1"), "Acct 1");
  assert.equal(a.renamedTo("Customer 1"), "Acct 1");
  a.close();

  // Reopen: the chain is rebuilt from the append-only log.
  const b = new MappingStore(path, { mode: "sequential" });
  assert.equal(b.renamedTo("Client 1"), "Acct 1");
  assert.equal(b.renamedTo("Customer 1"), "Acct 1");
  assert.equal(b.renamedTo("Acct 1"), undefined);
  b.close();
});

test("hmac mode is deterministic across machines (stores)", () => {
  const a = new MappingStore(tmpDb(), { mode: "hmac", hmacSecret: "team-secret" });
  const b = new MappingStore(tmpDb(), { mode: "hmac", hmacSecret: "team-secret" });
  const ta = a.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  const tb = b.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  assert.equal(ta, tb);
  assert.match(ta, /^Client_[0-9a-f]{8}$/);
  a.close();
  b.close();
});

test("email mask and linked sequence share the entity index", () => {
  const s = new MappingStore(tmpDb(), { mode: "sequential" });
  s.getOrCreateToken("names", "Client", "token", "Contoso Ltd"); // Client 1
  const seq = s.lookupByValue("names", "Contoso Ltd")!.seq;
  const email = s.getOrCreateToken("emails", "Client", "email", "info@contoso.com", seq);
  assert.equal(email, "client1@masked.example");
  s.close();
});

test("hmac mode without secret throws", () => {
  assert.throws(() => new MappingStore(tmpDb(), { mode: "hmac" }));
});

test("two stores on one file stay consistent (UI + proxy running together)", () => {
  const path = tmpDb();
  const a = new MappingStore(path, { mode: "sequential" });
  const b = new MappingStore(path, { mode: "sequential" });

  const t1 = a.getOrCreateToken("g", "Client", "token", "Contoso Ltd");
  assert.equal(t1, "Client 1");
  // b allocated nothing yet — it must see a's record and NOT reuse the token.
  const t2 = b.getOrCreateToken("g", "Client", "token", "Fabrikam Inc");
  assert.equal(t2, "Client 2", "second process must continue the sequence, not collide");
  assert.equal(b.lookupByToken("Client 1"), "Contoso Ltd");
  // and a sees b's record on its next lookup.
  assert.equal(a.getOrCreateToken("g", "Client", "token", "Fabrikam Inc"), "Client 2");
  a.close();
  b.close();
});
