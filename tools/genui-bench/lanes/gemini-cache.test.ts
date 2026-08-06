/**
 * Unit tests for the Gemini cache manager's guards — the paths that decide
 * WHETHER to cache, without any network. Cache creation itself is a live REST
 * call proven by the bench run and the caching sanity check (README v2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHING_DISABLED, cachedSystemName } from "./gemini-cache";

const BIG = "x".repeat(5000);

describe("gemini cache guards", () => {
  beforeEach(() => {
    delete process.env.GENUI_BENCH_NO_CACHE;
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.GENUI_BENCH_NO_CACHE;
    vi.restoreAllMocks();
  });

  it("GENUI_BENCH_NO_CACHE disables caching (the sanity-check switch)", async () => {
    process.env.GENUI_BENCH_NO_CACHE = "1";
    expect(CACHING_DISABLED()).toBe(true);
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(cachedSystemName("gemini-3.6-flash", BIG)).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a system below the cache minimum is never sent to the cache API", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(cachedSystemName("gemini-3.6-flash", "too small")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a failed create resolves to null so the lane falls back to inline system", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 400, json: async () => ({}) } as Response);
    // A distinct system string avoids the in-process memo from other tests.
    await expect(cachedSystemName("gemini-3.6-flash", `${BIG}-fail`)).resolves.toBeNull();
  });

  it("a successful create returns the cache resource name, memoized per system", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: "cachedContents/abc" }) } as Response);
    const system = `${BIG}-ok`;
    await expect(cachedSystemName("gemini-3.6-flash", system)).resolves.toBe("cachedContents/abc");
    // Second call for the same system reuses the memo — no second create.
    await expect(cachedSystemName("gemini-3.6-flash", system)).resolves.toBe("cachedContents/abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
