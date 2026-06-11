import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PgQueue,
  QueueStatus,
  type QueueStateUpdate,
} from "../src/postgres/queue.js";

type Payload = { step: string };

const databaseUrl = process.env.DATABASE_URL;

// Unique per-run table name so concurrent or aborted runs don't collide.
const TABLE = `utils_test.pg_queue_test_${Date.now().toString(36)}`;

const done: QueueStateUpdate<Payload> = {
  status: { value: QueueStatus.Done },
};

describe.skipIf(!databaseUrl)("PgQueue", () => {
  let pool: pg.Pool;
  let queue: PgQueue<Payload>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(`
      CREATE TABLE ${TABLE} (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        scope            text        NOT NULL,
        data             jsonb       NOT NULL,
        status           text        NOT NULL DEFAULT 'queued',
        entered_queue_at timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        attempt_count    integer     NOT NULL DEFAULT 0
      )
    `);
    queue = new PgQueue<Payload>({ pool, table: TABLE });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TABLE}`);
  });

  async function getRow(id: string) {
    const { rows } = await pool.query(
      `SELECT
         status,
         data,
         entered_queue_at AS "enteredQueueAt",
         attempt_count AS "attemptCount"
       FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  it("addItem inserts a queued item and returns it", async () => {
    const item = await queue.addItem("scope-a", { step: "start" });

    expect(item.id).toBeTruthy();
    expect(item.scope).toBe("scope-a");
    expect(item.data).toEqual({ step: "start" });
    expect(item.status).toBe(QueueStatus.Queued);
    expect(item.attemptCount).toBe(0);
    expect(item.enteredQueueAt).toBeInstanceOf(Date);
  });

  it("processNext returns null when the queue is empty", async () => {
    const item = await queue.processNext(async () => done);
    expect(item).toBeNull();
  });

  it("claims an item as PROCESSING and marks it DONE on success", async () => {
    const created = await queue.addItem("scope-a", { step: "start" });

    let seen: unknown;
    const claimed = await queue.processNext(async (item) => {
      seen = item;
      return done;
    });

    expect(claimed?.id).toBe(created.id);
    expect(seen).toMatchObject({
      id: created.id,
      status: QueueStatus.Processing,
      attemptCount: 1,
      data: { step: "start" },
    });

    const row = await getRow(created.id);
    expect(row.status).toBe(QueueStatus.Done);
    expect(row.attemptCount).toBe(1);
  });

  it("marks the item FAILED when the handler throws", async () => {
    const created = await queue.addItem("scope-a", { step: "start" });

    const claimed = await queue.processNext(async () => {
      throw new Error("boom");
    });

    expect(claimed?.id).toBe(created.id);
    const row = await getRow(created.id);
    expect(row.status).toBe(QueueStatus.Failed);
  });

  it("re-queues at requeueAt and skips the item until it is due", async () => {
    const created = await queue.addItem("scope-a", { step: "start" });
    const requeueAt = new Date(Date.now() + 60_000);

    await queue.processNext(async () => ({
      status: { value: QueueStatus.Queued, requeueAt },
    }));

    const row = await getRow(created.id);
    expect(row.status).toBe(QueueStatus.Queued);
    expect(row.enteredQueueAt.getTime()).toBe(requeueAt.getTime());

    // Not due yet, so it can't be claimed.
    expect(await queue.processNext(async () => done)).toBeNull();
  });

  it("claims a re-queued item again once it is due", async () => {
    const created = await queue.addItem("scope-a", { step: "start" });

    await queue.processNext(async () => ({
      status: { value: QueueStatus.Queued, requeueAt: new Date(Date.now() - 1000) },
    }));

    const claimed = await queue.processNext(async () => done);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.attemptCount).toBe(2);
  });

  it("replaces the item's data when the handler returns newState", async () => {
    const created = await queue.addItem("scope-a", { step: "start" });

    await queue.processNext(async () => ({
      ...done,
      newState: { step: "finished" },
    }));

    const row = await getRow(created.id);
    expect(row.data).toEqual({ step: "finished" });
  });

  it("only claims items in the given scope", async () => {
    // The scope-a item is older, so an unscoped claim would pick it first.
    const inA = await queue.addItem("scope-a", { step: "a" });
    const inB = await queue.addItem("scope-b", { step: "b" });

    const claimed = await queue.processNext(async () => done, "scope-b");
    expect(claimed?.id).toBe(inB.id);

    expect(await queue.processNext(async () => done, "scope-b")).toBeNull();
    expect((await getRow(inA.id)).status).toBe(QueueStatus.Queued);
  });

  it("does not claim an item deferred via enqueueAt", async () => {
    await queue.addItem("scope-a", { step: "later" }, new Date(Date.now() + 60_000));
    expect(await queue.processNext(async () => done)).toBeNull();
  });

  it("claims the oldest due item first", async () => {
    const older = await queue.addItem(
      "scope-a",
      { step: "old" },
      new Date(Date.now() - 120_000),
    );
    await queue.addItem("scope-a", { step: "new" }, new Date(Date.now() - 60_000));

    const claimed = await queue.processNext(async () => done);
    expect(claimed?.id).toBe(older.id);
  });

  it("never hands the same item to two concurrent workers", async () => {
    await queue.addItem("scope-a", { step: "one" });
    await queue.addItem("scope-a", { step: "two" });

    const slowDone = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return done;
    };
    const [first, second] = await Promise.all([
      queue.processNext(slowDone),
      queue.processNext(slowDone),
    ]);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first!.id).not.toBe(second!.id);
  });
});
