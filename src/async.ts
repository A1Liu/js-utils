export interface UnwrappedPromise<T> {
  value?: T;
  promise: Promise<T>;
}

export class Future<T> {
  readonly promise: Promise<T>;
  readonly resolve: (t: T) => unknown;
  readonly reject: (err: unknown) => unknown;
  private _valueSlot: T | undefined;

  constructor() {
    let resolve: (t: T) => unknown = () => {};
    let reject: (err: unknown) => unknown = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    promise.then((value) => (this._valueSlot = value));

    this.promise = promise;
    this.resolve = resolve;
    this.reject = reject;
  }

  static unwrapPromise<K>(promise: Promise<K>): UnwrappedPromise<K> {
    let _valueSlot: K | undefined = undefined;
    promise.then((k) => {
      _valueSlot = k;
    });
    return {
      promise,
      get value(): K | undefined {
        return _valueSlot;
      },
    };
  }

  get value(): T | undefined {
    return this._valueSlot;
  }

  get unwrapped(): UnwrappedPromise<T> {
    const fut = this;
    return {
      promise: fut.promise,
      get value(): T | undefined {
        return fut._valueSlot;
      },
    };
  }
}

export async function allSettled<T extends Record<string, Promise<unknown>>>(
  t: T,
): Promise<
  | { ok: true; results: { [K in keyof T]: Awaited<T[K]> } }
  | {
      ok: false;
      results: { [K in keyof T]?: Awaited<T[K]> };
      errors: { [K in keyof T]?: Error };
    }
> {
  const resultsArray = await Promise.all(
    Object.entries(t).map(
      async ([key, value]): Promise<[keyof T, unknown, Error | null]> => {
        try {
          return [key, await value, null];
        } catch (e) {
          return [key, null, e instanceof Error ? e : new Error(String(e))];
        }
      },
    ),
  );

  let ok = true;
  const results: any = {};
  const errors: { [K in keyof T]?: Error } = {};

  for (const [key, result, error] of resultsArray) {
    if (error) {
      errors[key] = error;
      ok = false;
    } else {
      results[key] = result;
    }
  }

  return { ok, results, errors };
}

export async function all<T extends Record<string, Promise<unknown>>>(
  t: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const resultsArray = await Promise.all(
    Object.entries(t).map(async ([key, value]): Promise<[keyof T, unknown]> => {
      return [key, await value];
    }),
  );

  const results: any = {};

  for (const [key, result] of resultsArray) {
    results[key] = result;
  }

  return results;
}

export default {
  Future,
  all,
  allSettled,
};
