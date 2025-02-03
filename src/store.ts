import { IDBPDatabase, openDB } from "idb";

export interface KVStore<T> extends AsyncIterable<[string[], T]> {
  getValue(key: string[]): Promise<T>;
  setValue(key: string[], value: T): Promise<void>;
  setValues(pairs: [string[], T][]): Promise<void>;
}

export class IndexedDbStore<T> implements KVStore<T> {
  private readonly db: Promise<IDBPDatabase<unknown>>;

  constructor(
    readonly dbName: string,
    readonly storeName: string,
  ) {
    this.db = openDB(dbName, 1, {
      upgrade: (db) => {
        db.createObjectStore(this.storeName);
      },
    });
  }

  async getValue(key: string[]): Promise<T> {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const value = await store.get(key);
    return value as unknown as T;
  }

  async setValue(key: string[], value: T): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    await store.put(value, key);
    tx.commit();
  }

  async setValues(pairs: [string[], T][]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);

    await Promise.allSettled(
      pairs.map(([key, value]) => store.put(value, key)),
    );

    tx.commit();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<[string[], T], any, any> {
    const db = await this.db;
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);

    for await (const cursorValue of store.iterate(null)) {
      yield [cursorValue.key as string[], cursorValue.value as unknown as T];
    }
  }
}
