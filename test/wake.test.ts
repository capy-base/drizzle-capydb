import { describe, expect, it, vi } from "vitest";

import { isCellWakingError, waitForWake } from "../src/index";

/** Minimal stand-in for the postgres-js tagged-template client. */
function fakeClient(behaviours: Array<Error | "ok">) {
  let call = 0;
  const client = (() => {
    const outcome = behaviours[Math.min(call, behaviours.length - 1)];
    call += 1;
    return outcome === "ok" ? Promise.resolve([{ "?column?": 1 }]) : Promise.reject(outcome);
  }) as unknown as Parameters<typeof waitForWake>[0];
  return {
    client,
    get calls() {
      return call;
    },
  };
}

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe("isCellWakingError", () => {
  it("treats pause/resume conditions as transient", () => {
    // The cell was paused mid-session by the idle sweep.
    expect(isCellWakingError(pgError("57P01"))).toBe(true);
    // Still resuming.
    expect(isCellWakingError(pgError("57P03"))).toBe(true);
    expect(isCellWakingError(pgError("ECONNRESET"))).toBe(true);
  });

  it("does not treat real SQL failures as transient", () => {
    expect(isCellWakingError(pgError("42601"))).toBe(false); // syntax error
    expect(isCellWakingError(pgError("23505"))).toBe(false); // unique violation
    expect(isCellWakingError(pgError("28P01"))).toBe(false); // bad password
    expect(isCellWakingError(new Error("boom"))).toBe(false);
    expect(isCellWakingError(undefined)).toBe(false);
  });

  it("unwraps a nested cause", () => {
    const wrapped = new Error("connection failed", { cause: pgError("57P01") });
    expect(isCellWakingError(wrapped)).toBe(true);
  });

  it("does not loop forever on a self-referential cause", () => {
    const selfRef = new Error("weird") as Error & { cause?: unknown };
    selfRef.cause = selfRef;
    expect(isCellWakingError(selfRef)).toBe(false);
  });
});

describe("waitForWake", () => {
  it("returns as soon as the cell answers", async () => {
    // Note: read `fake.calls` through the object - destructuring would snapshot
    // the getter's value at zero.
    const fake = fakeClient(["ok"]);
    await waitForWake(fake.client);
    expect(fake.calls).toBe(1);
  });

  it("retries transient errors then succeeds", async () => {
    vi.useFakeTimers();
    const fake = fakeClient([pgError("57P03"), pgError("57P03"), "ok"]);
    const pending = waitForWake(fake.client, { baseDelayMs: 1 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(fake.calls).toBe(3);
    vi.useRealTimers();
  });

  it("rethrows a non-transient error immediately without retrying", async () => {
    const fake = fakeClient([pgError("28P01")]);
    await expect(waitForWake(fake.client)).rejects.toThrow("28P01");
    // Bad credentials will never become good; retrying would just stall CI.
    expect(fake.calls).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    vi.useFakeTimers();
    const fake = fakeClient([pgError("57P03")]);
    const pending = waitForWake(fake.client, { attempts: 3, baseDelayMs: 1 });
    const assertion = expect(pending).rejects.toThrow("did not become ready after 3 attempts");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fake.calls).toBe(3);
    vi.useRealTimers();
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient(["ok"]);
    await expect(waitForWake(fake.client, { signal: controller.signal })).rejects.toThrow();
    expect(fake.calls).toBe(0);
  });
});
