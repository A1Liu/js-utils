import { Future, Mutex, timePromise } from "./async";
import { PersistStorage, StorageValue } from "zustand/middleware";
import { z } from "zod";
import { get, set, del } from "idb-keyval";
import type { DebounceSettings } from "lodash";
import debounce from "lodash/debounce";
import { getOrCompute } from "./util";

export function zustandJsonReviver(_key: string, value: unknown): unknown {
  try {
    if (!value || typeof value !== "object" || !("__typename" in value)) {
      return value;
    }

    switch (value.__typename) {
      case "Map": {
        const schema = z.object({
          state: z.array(z.tuple([z.string(), z.unknown()])),
        });
        const parsed = schema.parse(value);

        return new Map(parsed.state);
      }
      case "Date": {
        const schema = z.object({ state: z.string() });
        const parsed = schema.parse(value);

        return new Date(parsed.state);
      }

      default:
        throw new Error(`Unrecognized typename: ${value.__typename}`);
    }
  } catch (e) {
    console.error(
      `Unrecognized typename: ${String(JSON.stringify(value))} with ${e}`,
    );
  }
}

export function zustandJsonReplacer(
  this: unknown,
  _key: string,
  value: unknown,
): unknown {
  if (value instanceof Map) {
    return {
      __typename: "Map",
      state: [...value.entries()],
    };
  }

  if (typeof this !== "object" || !this) {
    return value;
  }

  const holder = this as Record<string, unknown>;
  const rawValue = holder[_key];
  if (rawValue instanceof Date) {
    return {
      __typename: "Date",
      state: rawValue.toISOString(),
    };
  }

  return value;
}

// TODO: test this code please
class Debouncer {
  private currentFut = new Future<true>();
  private isRunning = false;

  private readonly debouncedFunc: (
    r: () => Promise<void>,
  ) => Promise<void> | undefined;

  constructor(waitTime?: number, opts?: DebounceSettings) {
    const leading = opts?.leading;
    const trailing = opts?.trailing ?? true;

    this.debouncedFunc = debounce(
      async (r) => {
        // TODO: timeouts
        if (this.isRunning) {
          return; // If we're already running, we shouldn't run again.
        }

        if (leading && this.currentFut.value) {
          this.currentFut = new Future();
        }

        try {
          await r();
        } catch (error) {
          console.error(`Failure ${String(error)}`);
        } finally {
          this.isRunning = false;
          this.currentFut.resolve(true);

          if (trailing) {
            this.currentFut = new Future();
          }
        }
      },
      waitTime,
      opts,
    );
  }

  async run(r: () => Promise<void>) {
    this.debouncedFunc(r);

    return await this.currentFut.promise;
  }
}

// operations should be linearized
// set operations and remove operations should be debounced
class IdbStorage implements PersistStorage<unknown> {
  private readonly mutexes = new Map<string, Mutex>();
  private readonly debouncers = new Map<string, Debouncer>();

  mutex(name: string) {
    return getOrCompute(this.mutexes, name, () => new Mutex());
  }

  debouncer(name: string) {
    const debouncer = getOrCompute(
      this.debouncers,
      name,
      () =>
        new Debouncer(500, {
          leading: true,
          trailing: true,
          maxWait: 5_000,
        }),
    );
    return {
      async debounce(r: () => Promise<void>) {
        await debouncer.run(r);
      },
    };
  }

  async getItem(name: string): Promise<StorageValue<unknown> | null> {
    return this.mutex(name).run(async () => {
      const { result, duration } = await timePromise(() => get(name));
      console.log(
        `Read ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
      );
      if (!result.success) throw result.error;

      return result.value;
    });
  }

  async setItem(name: string, value: StorageValue<unknown>): Promise<void> {
    await this.debouncer(name).debounce(() => {
      return this.mutex(name).run(async () => {
        const { result, duration } = await timePromise(() => set(name, value));
        console.log(
          `Wrote ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
        );
      });
    });
  }

  async removeItem(name: string): Promise<void> {
    return this.mutex(name).run(async () => {
      const { result, duration } = await timePromise(() => del(name));
      console.log(
        `Deleted ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
      );
    });
  }
}

export const ZustandIdbStorage: PersistStorage<unknown> = new IdbStorage();
