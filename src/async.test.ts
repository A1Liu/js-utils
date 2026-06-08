import { describe, it, expect, vi } from "vitest";
import { Future, all, allSettled, timePromise } from "./async.js";

describe("Future", () => {
  it("starts pending with no value", () => {
    const f = new Future<number>();
    expect(f.done).toBe(false);
    expect(f.value).toBeUndefined();
  });

  it("resolves and exposes the value synchronously after resolution", async () => {
    const f = new Future<number>();
    f.resolve(42);

    expect(f.done).toBe(true);
    expect(f.value).toBe(42);
    await expect(f.promise).resolves.toBe(42);
  });

  it("rejects and marks itself done", async () => {
    const f = new Future<number>();
    const err = new Error("boom");
    f.reject(err);

    expect(f.done).toBe(true);
    // value is only set on success
    expect(f.value).toBeUndefined();
    await expect(f.promise).rejects.toBe(err);
  });

  it("ignores resolve after it has already settled", async () => {
    const f = new Future<number>();
    f.resolve(1);
    f.resolve(2);

    expect(f.value).toBe(1);
    await expect(f.promise).resolves.toBe(1);
  });

  it("ignores resolve after a rejection", async () => {
    const f = new Future<number>();
    const err = new Error("first");
    f.reject(err);
    f.resolve(99);

    expect(f.value).toBeUndefined();
    await expect(f.promise).rejects.toBe(err);
  });

  it("ignores reject after it has already resolved", async () => {
    const f = new Future<number>();
    f.resolve(7);
    f.reject(new Error("late"));

    expect(f.value).toBe(7);
    await expect(f.promise).resolves.toBe(7);
  });

  describe("static resolve", () => {
    it("returns an already-resolved future", async () => {
      const f = Future.resolve("hello");

      expect(f.done).toBe(true);
      expect(f.value).toBe("hello");
      await expect(f.promise).resolves.toBe("hello");
    });
  });

  describe("static unwrapPromise", () => {
    it("exposes the value once the underlying promise resolves", async () => {
      const promise = Promise.resolve(123);
      const unwrapped = Future.unwrapPromise(promise);

      // Not yet observed synchronously.
      expect(unwrapped.value).toBeUndefined();

      await unwrapped.promise;
      expect(unwrapped.value).toBe(123);
    });

    it("returns the same promise it was given", () => {
      const promise = Promise.resolve(1);
      const unwrapped = Future.unwrapPromise(promise);
      expect(unwrapped.promise).toBe(promise);
    });
  });

  describe("unwrapped getter", () => {
    it("tracks the future's value", async () => {
      const f = new Future<string>();
      const unwrapped = f.unwrapped;

      expect(unwrapped.value).toBeUndefined();
      expect(unwrapped.promise).toBe(f.promise);

      f.resolve("done");
      expect(unwrapped.value).toBe("done");
    });
  });
});

describe("all", () => {
  it("resolves a record of promises into a record of values", async () => {
    const result = await all({
      a: Promise.resolve(1),
      b: Promise.resolve("two"),
    });

    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("handles an empty record", async () => {
    const result = await all({});
    expect(result).toEqual({});
  });

  it("rejects if any promise rejects", async () => {
    const err = new Error("nope");
    await expect(
      all({ a: Promise.resolve(1), b: Promise.reject(err) }),
    ).rejects.toBe(err);
  });
});

describe("allSettled", () => {
  it("returns ok with all results when every promise resolves", async () => {
    const result = await allSettled({
      a: Promise.resolve(1),
      b: Promise.resolve("two"),
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual({ a: 1, b: "two" });
    if (result.ok) {
      // type narrowing: no errors field on the ok branch
      expect(result.results.a).toBe(1);
    }
  });

  it("collects errors and partial results when some promises reject", async () => {
    const err = new Error("failed b");
    const result = await allSettled({
      a: Promise.resolve(1),
      b: Promise.reject(err),
    });

    expect(result.ok).toBe(false);
    expect(result.results).toEqual({ a: 1 });
    if (!result.ok) {
      expect(result.errors.b).toBe(err);
      expect(result.errors.a).toBeUndefined();
    }
  });

  it("wraps non-Error rejections in an Error", async () => {
    const result = await allSettled({ a: Promise.reject("string failure") });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.a).toBeInstanceOf(Error);
      expect(result.errors.a?.message).toBe("string failure");
    }
  });

  it("reports ok for an empty record", async () => {
    const result = await allSettled({});
    expect(result.ok).toBe(true);
    expect(result.results).toEqual({});
  });
});

describe("timePromise", () => {
  it("measures duration and returns a success result", async () => {
    const result = await timePromise(async () => "value");

    expect(result.result).toEqual({ success: true, value: "value" });
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("captures a thrown error as a failure result", async () => {
    const err = new Error("kaboom");
    const result = await timePromise(async () => {
      throw err;
    });

    expect(result.result).toEqual({ success: false, error: err });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("reflects elapsed time using the clock", async () => {
    const nowSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(350);

    const result = await timePromise(async () => 1);

    expect(result.duration).toBe(250);
    nowSpy.mockRestore();
  });
});
