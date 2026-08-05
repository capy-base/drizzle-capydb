import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { withAuthContext, withSupabaseJwtClaims } from "../src/index";

const dialect = new PgDialect();

/**
 * Minimal stand-in for a drizzle postgres-js database: records every
 * statement executed inside the transaction so tests can render it to
 * parameterized SQL and inspect exactly what would hit the wire.
 */
function fakeDb() {
  const executed: SQL[] = [];
  const tx = {
    execute: vi.fn(async (query: SQL) => {
      executed.push(query);
      return [];
    }),
  };
  const db = {
    transaction: vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return {
    db: db as unknown as Parameters<typeof withAuthContext>[0],
    raw: db,
    tx,
    executed,
  };
}

function render(query: SQL) {
  return dialect.sqlToQuery(query);
}

describe("withAuthContext", () => {
  it("sets the context as one transaction-local set_config statement", async () => {
    const { db, executed } = fakeDb();
    await withAuthContext(
      db,
      {
        userId: "11111111-1111-1111-1111-111111111111",
        set: { "app.org_id": "acme" },
      },
      async () => "done",
    );
    expect(executed).toHaveLength(1);
    const first = executed[0];
    if (first === undefined) throw new Error("no statement executed");
    const { sql: text, params } = render(first);
    // is_local = true is the whole point: SET LOCAL semantics survive
    // transaction pooling; a session-level SET would leak across clients.
    expect(text).toBe("select set_config($1, $2, true), set_config($3, $4, true)");
    expect(params).toEqual([
      "app.user_id",
      "11111111-1111-1111-1111-111111111111",
      "app.org_id",
      "acme",
    ]);
  });

  it("runs the callback inside the same transaction and returns its result", async () => {
    const { db, raw, tx } = fakeDb();
    const result = await withAuthContext(db, { userId: "u" }, async (handle) => {
      expect(handle).toBe(tx);
      return 42;
    });
    expect(result).toBe(42);
    expect(raw.transaction).toHaveBeenCalledOnce();
  });

  it("serializes claims to JSON under app.claims", async () => {
    const { db, executed } = fakeDb();
    await withAuthContext(db, { claims: { tier: "pro", org: { id: 7 } } }, async () => undefined);
    const first = executed[0];
    if (first === undefined) throw new Error("no statement executed");
    const { params } = render(first);
    expect(params).toEqual(["app.claims", '{"tier":"pro","org":{"id":7}}']);
  });

  it("opens the transaction but sets nothing for an empty context", async () => {
    const { db, raw, tx } = fakeDb();
    await withAuthContext(db, {}, async () => undefined);
    expect(raw.transaction).toHaveBeenCalledOnce();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("rejects undotted custom GUC names before touching the database", async () => {
    const { db, raw } = fakeDb();
    await expect(
      withAuthContext(db, { set: { org_id: "acme" } }, async () => undefined),
    ).rejects.toThrow(/dotted name like "app\.org_id"/);
    expect(raw.transaction).not.toHaveBeenCalled();
  });
});

describe("withSupabaseJwtClaims", () => {
  it("sets the whole claims object as request.jwt.claims for the compat shim", async () => {
    const { db, executed } = fakeDb();
    await withSupabaseJwtClaims(db, { sub: "u1", role: "authenticated" }, async () => undefined);
    const first = executed[0];
    if (first === undefined) throw new Error("no statement executed");
    const { sql: text, params } = render(first);
    expect(text).toBe("select set_config($1, $2, true)");
    expect(params).toEqual(["request.jwt.claims", '{"sub":"u1","role":"authenticated"}']);
  });
});
