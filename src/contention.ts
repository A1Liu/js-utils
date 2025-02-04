import { Future } from "./async";
import type { DebounceSettings } from "lodash";
import debounce from "lodash/debounce";

// Is Effect.ts the right thing to use here? It's interesting,
// but also a lot to deal with.

// Deduplicates multipe calls to a long-running task. If trailing is true,
// subsequent calls while the task is running will be deduplicated into a single
// task, which will execute the most recent call. If trailing is false, then
// subsequent calls will be be destroyed.
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
    const newFut = new Future<T>();
    this.nextFut = newFut;

    if (this.currentFut?.done === false) {
      await this.currentFut.promise;
    }

    if (this.trailing) {
      this.currentFut = this.nextFut;
      this.nextFut = undefined;
    }

    try {
      const val = await this.nextRun();
      newFut.resolve(val);
      return val;
    } catch (e) {
      newFut.reject(e);
      throw e;
    } finally {
      if (!this.trailing) {
        this.nextFut = undefined;
      }
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
