import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * QQ misbehaves when searched repeatedly in quick succession, so every
 * request funnels through one serializing chain. These tests pin that
 * behaviour on a local copy of the same implementation: importing the
 * real module would drag in the Tauri HTTP plugin, which has no
 * meaning outside the app shell.
 */

const MIN_REQUEST_GAP_MS = 400;

function makeSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;
  return function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        lastRequestAt = Date.now();
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("QQ request serialization", () => {
  it("never runs two requests concurrently", async () => {
    const serialized = makeSerializer();
    let inFlight = 0;
    let maxInFlight = 0;

    const task = () =>
      serialized(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return "ok";
      });

    const all = Promise.all([task(), task(), task(), task(), task()]);
    await vi.runAllTimersAsync();
    await expect(all).resolves.toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(maxInFlight).toBe(1);
  });

  it("preserves call order", async () => {
    const serialized = makeSerializer();
    const order: number[] = [];
    const task = (n: number) =>
      serialized(async () => {
        order.push(n);
      });

    const all = Promise.all([task(1), task(2), task(3)]);
    await vi.runAllTimersAsync();
    await all;
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps working after a request rejects", async () => {
    // A wedged chain would silently disable QQ for the rest of the
    // session, which is worse than the failure that caused it.
    const serialized = makeSerializer();
    const failed = serialized(async () => {
      throw new Error("boom");
    });
    const after = serialized(async () => "recovered");

    await vi.runAllTimersAsync();
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("recovered");
  });
});
