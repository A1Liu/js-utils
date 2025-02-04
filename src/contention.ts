import { Future } from "./async";
import type { DebounceSettings } from "lodash";
import debounce from "lodash/debounce";

// Is Effect.ts the right thing to use here? It's interesting,
// but also a lot to deal with.

export class Dedup<T> {
  private currentFut?: Future<T>;
  private nextRun?: () => T;
  private nextFut?: Future<T>;

  constructor(readonly trailing: boolean = true) {}

  async run(r: () => T): Promise<T> {
    this.nextRun = r;
    if (this.nextFut) {
      return this.nextFut.promise;
    }
    this.nextFut = new Future<T>();

    if (this.currentFut?.done === false) {
      await this.currentFut.promise;
    }

    this.currentFut = this.nextFut;
    this.nextFut = undefined;

    try {
      const val = await this.nextRun();
      this.currentFut.resolve(val);
      return val;
    } catch (e) {
      this.currentFut.reject(e);
      throw e;
    }
  }
}

// TODO: test this code please
export class Debouncer {
  private readonly debouncedFunc: (
    r: () => Promise<void>,
  ) => Promise<void> | undefined;

  constructor(waitTime?: number, opts?: DebounceSettings) {
    this.debouncedFunc = debounce(async (r) => r(), waitTime, opts);
  }

  async run(r: () => Promise<void>) {
    await this.debouncedFunc(r);
  }
}

// TODO: test this code please
export class Mutex {
  private isRunning = false;
  private readonly listeners: (() => unknown)[] = [];

  async run<T>(run: () => Promise<T>): Promise<T> {
    const this_ = this;

    const fut = new Future<T>();

    async function mutexRunner() {
      try {
        const returnValue = await run();
        fut.resolve(returnValue);
      } catch (error) {
        fut.reject(error);
        console.error(`Error in storage`, error);
      } finally {
        const nextListener = this_.listeners.shift();
        if (!nextListener) {
          this_.isRunning = false;
          return;
        }

        setTimeout(nextListener, 0);
      }
    }
    if (!this_.isRunning) {
      this_.isRunning = true;
      mutexRunner();
    } else {
      this_.listeners.push(mutexRunner);
    }

    return fut.promise;
  }
}
