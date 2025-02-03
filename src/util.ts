export function assertUnreachable(_: never): void {
  console.error("unreachable code executed");
}

export function timeout(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function memoize<T>(_maker: () => T): {
  (): T;
  clear: () => void;
  memoizedValue?: T;
} {
  let maker: (() => T) | undefined = _maker;

  const func = () => {
    if (maker) {
      const result = maker();
      maker = undefined;
      func.memoizedValue = result;
      return result;
    }

    return func.memoizedValue as T;
  };

  func.memoizedValue = undefined as undefined | T;
  func.clear = () => {
    maker = _maker;
    func.memoizedValue = undefined;
  };

  return func;
}

// Gets from Map. If the value doesn't exist, compute it using the provided lambda
// and store it in the map, and then return it
export function getOrCompute<T>(
  map: Map<string, T>,
  key: string,
  make: () => T,
): T {
  const value = map.get(key);
  if (value !== undefined) return value;

  const newValue = make();
  map.set(key, newValue);

  return newValue;
}

// TODO: RxJS or similar thing
export class Observable {
  private subscribers: (() => void)[] = [];

  private pushUpdate() {
    this.subscribers.forEach((s) => s());
  }

  static create(): [() => void, Observable] {
    const o = new Observable();
    return [() => o.pushUpdate(), o];
  }

  subscribe(cb: () => void) {
    this.subscribers.push(cb);
  }

  unsubscribe(cb: () => void) {
    this.subscribers = this.subscribers.filter((sub) => sub !== cb);
  }
}

export const Struct = {
  allNotNil: function structAllNotNil<T extends Record<string, unknown>>(
    t: Required<T>,
  ):
    | { ok: true; data: { [K in keyof T]: NonNullable<T[K]> } }
    | { ok: false; missing: (keyof T)[] } {
    const nullishFields = Object.entries(t).filter(
      ([_k, v]) => v === null || v === undefined,
    );
    if (nullishFields.length > 0) {
      return { ok: false, missing: nullishFields.map(([k]) => k) };
    }

    return {
      ok: true,
      data: { ...t } as unknown as { [K in keyof T]: NonNullable<T[K]> },
    };
  },
};
