import { timePromise } from "./async";
import { PersistStorage, StorageValue } from "zustand/middleware";
import { z } from "zod";
import { Debouncer } from "./contention";
import { getOrCompute } from "./util";
import { IDBPDatabase, openDB } from "idb";

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


// TODO:
// Some thoughts on when you need a large cache of data and don't want it in
// memory:
// - Use IDB
// - Maybe build an adapter which updates a larger IDB store for a single record?
//   - The adapter knows which record the zustand state is looking at
//   - When the record changes, the state changes
//   - Vice-versa, when the state changes the record in IDB changes
//   - ^ Maybe it's not worth it to use zustand for this?


// operations should be linearized
// set operations and remove operations should be debounced
export class IdbZustandStorage implements PersistStorage<unknown> {
  private readonly db: Promise<IDBPDatabase<unknown>>;
  private readonly debouncers = new Map<string, Debouncer>();

  constructor(
    readonly databaseName = "idb-storage",
    readonly storeName = "object-store",
  ) {
    this.db = openDB(databaseName, 1, {
      upgrade(db) {
        db.createObjectStore(databaseName);
      },
    });
  }

  debouncer(name: string) {
    const debouncer = getOrCompute(
      this.debouncers,
      name,
      () =>
        new Debouncer(2_500, {
          leading: true,
          trailing: true,
          maxWait: 5_000,
        }),
    );
    return debouncer;
  }

  async getItem(name: string): Promise<StorageValue<unknown> | null> {
    const db = await this.db;
    const { result, duration } = await timePromise(() =>
      db.get(this.storeName, name),
    );
    console.log(
      `Read ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
    );
    if (!result.success) throw result.error;

    return result.value;
  }

  async setItem(name: string, value: StorageValue<unknown>): Promise<void> {
    this.debouncer(name).run(async () => {
      const db = await this.db;
      const { result, duration } = await timePromise(() =>
        db.put(this.storeName, value, name),
      );
      console.log(
        `Wrote ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
      );
    });
  }

  async removeItem(name: string): Promise<void> {
    const db = await this.db;
    const { result, duration } = await timePromise(() =>
      db.delete(this.storeName, name),
    );
    console.log(
      `Deleted ${name}${!result.success ? " (failed)" : ""} in ${duration}ms`,
    );
  }

  async* readDbSnapshot(): AsyncIterator<[string, unknown], any, any> {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);

    for await (const cursorValue of store.iterate(null)) {
      yield [cursorValue.key as unknown as string, cursorValue.value];
    }

    tx.commit();
  }

  async restoreDbFromSnapshot(values: readonly (readonly [string, unknown])[]) {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);

    await Promise.allSettled(
      values.map(([key, value]) => store.put(value, key)),
    );

    tx.commit();
  }
}

// export const ZustandIdbStorage: PersistStorage<unknown> = new IdbStorage();
