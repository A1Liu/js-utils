import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import {
  catchAndRetry,
  createMigration,
  PgQueue,
  PgQueueDataError,
  QueueStatus,
  type QueueStateUpdate,
} from "../../src/postgres/queue";

const Payload = z.object({ step: z.string() });
type Payload = z.infer<typeof Payload>;

const databaseUrl = process.env.DATABASE_URL;

// Unique per-run table name so concurrent or aborted runs don't collide.
const TABLE = `pg_queue_test_${Date.now().toString(36)}`;

// A uuid the table never hands out, for the "no such row" cases.
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

const done: QueueStateUpdate<Payload> = {
  status: { value: QueueStatus.Done },
};

describe("createMigration", () => {
  it("quotes the table name and leaves it unqualified", () => {
    const migration = createMigration("items");

    expect(migration).toContain(`CREATE TABLE "items" (`);
    expect(migration).toContain(`ON "items" (status, entered_queue_at)`);
    expect(migration).not.toContain(".");
  });

  it("qualifies the table with the schema when one is given", () => {
    const migration = createMigration("items", "main");

    expect(migration).toContain(`CREATE TABLE "main"."items" (`);
    expect(migration).toContain(`ON "main"."items" (scope, status`);
  });

  it("ignores a blank schema", () => {
    expect(createMigration("items", "   ")).toBe(createMigration("items"));
  });

  it("doubles every quote in an identifier", () => {
    const migration = createMigration('a"b"c', 'd"e');

    expect(migration).toContain(`CREATE TABLE "d""e"."a""b""c" (`);
    // The index names are built from the table name, so they need it too.
    expect(migration).toContain(`"a""b""c_status_entered_queue_at_idx"`);
    expect(migration).toContain(`"a""b""c_scope_status_entered_queue_at_idx"`);
  });

  it("names both indexes after the table", () => {
    const migration = createMigration("items");

    expect(migration).toContain(`"items_status_entered_queue_at_idx"`);
    expect(migration).toContain(`"items_scope_status_entered_queue_at_idx"`);
  });
});

describe.skipIf(!databaseUrl)("PgQueue", () => {
  let pool: pg.Pool;
  let queue: PgQueue<Payload>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(createMigration(TABLE));
    queue = new PgQueue({ client: pool, table: TABLE, dataSchema: Payload });
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

  // A row written past the queue's own schema check, which is the only way a
  // payload `dataSchema` rejects gets into the table.
  async function insertRaw(data: unknown, scope = ""): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (scope, data) VALUES ($1, $2) RETURNING id`,
      [scope, JSON.stringify(data)],
    );
    return rows[0].id;
  }

  it("addItem inserts a queued item and returns it", async () => {
    const item = await queue.addItem({ step: "start" }, { scope: "scope-a" });

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
    const created = await queue.addItem({ step: "start" });

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
    const created = await queue.addItem({ step: "start" });

    const claimed = await queue.processNext(async () => {
      throw new Error("boom");
    });

    expect(claimed?.id).toBe(created.id);
    const row = await getRow(created.id);
    expect(row.status).toBe(QueueStatus.Failed);
  });

  it("requeues the item when it throws and auto-retry is enabled", async () => {
    const created = await queue.addItem({ step: "start" });

    const claimed = await queue.processNext(
      catchAndRetry(
        async () => {
          throw new Error("boom");
        },
        { baseBackoffMs: 5_000 },
      ),
    );

    expect(claimed?.id).toBe(created.id);
    const row = await getRow(created.id);
    expect(row.status).toBe(QueueStatus.Queued);
    expect(row.enteredQueueAt.getTime()).toBeGreaterThanOrEqual(
      new Date().getTime(),
    );
  });

  it("re-queues at requeueAt and skips the item until it is due", async () => {
    const created = await queue.addItem({ step: "start" });
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
    const created = await queue.addItem({ step: "start" });

    await queue.processNext(async () => ({
      status: {
        value: QueueStatus.Queued,
        requeueAt: new Date(Date.now() - 1000),
      },
    }));

    const claimed = await queue.processNext(async () => done);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.attemptCount).toBe(2);
  });

  it("replaces the item's data when the handler returns newState", async () => {
    const created = await queue.addItem({ step: "start" });

    await queue.processNext(async () => ({
      ...done,
      newState: { step: "finished" },
    }));

    const row = await getRow(created.id);
    expect(row.data).toEqual({ step: "finished" });
  });

  it("only claims items in the given scope", async () => {
    // The scope-a item is older, so an unscoped claim would pick it first.
    const inA = await queue.addItem({ step: "a" }, { scope: "scope-a" });
    const inB = await queue.addItem({ step: "b" }, { scope: "scope-b" });

    const claimed = await queue.processNext(async () => done, {
      scope: "scope-b",
    });
    expect(claimed?.id).toBe(inB.id);

    expect(
      await queue.processNext(async () => done, { scope: "scope-b" }),
    ).toBeNull();
    expect((await getRow(inA.id)).status).toBe(QueueStatus.Queued);
  });

  it("does not claim an item deferred via enqueueAt", async () => {
    await queue.addItem(
      { step: "later" },
      {
        scope: "scope-a",
        enqueueAt: new Date(Date.now() + 60_000),
      },
    );
    expect(await queue.processNext(async () => done)).toBeNull();
  });

  it("claims the oldest due item first", async () => {
    const older = await queue.addItem(
      { step: "old" },
      { enqueueAt: new Date(Date.now() - 120_000) },
    );
    await queue.addItem(
      { step: "new" },
      { enqueueAt: new Date(Date.now() - 60_000) },
    );

    const claimed = await queue.processNext(async () => done);
    expect(claimed?.id).toBe(older.id);
  });

  it("never hands the same item to two concurrent workers", async () => {
    await queue.addItem({ step: "one" });
    await queue.addItem({ step: "two" });

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

  describe("claimNext", () => {
    it("returns null when the queue is empty", async () => {
      expect(await queue.claimNext()).toBeNull();
    });

    it("hands back a PROCESSING item and settles nothing", async () => {
      const created = await queue.addItem({ step: "start" });

      const claimed = await queue.claimNext();

      expect(claimed).toMatchObject({
        id: created.id,
        status: QueueStatus.Processing,
        attemptCount: 1,
        data: { step: "start" },
      });
      // Still PROCESSING: the claim is the caller's to settle.
      expect((await getRow(created.id)).status).toBe(QueueStatus.Processing);
    });

    it("does not hand a claimed item to a second claimer", async () => {
      await queue.addItem({ step: "start" });

      expect(await queue.claimNext()).not.toBeNull();
      expect(await queue.claimNext()).toBeNull();
    });

    it("only claims items in the given scope", async () => {
      const inA = await queue.addItem({ step: "a" }, { scope: "scope-a" });
      const inB = await queue.addItem({ step: "b" }, { scope: "scope-b" });

      expect((await queue.claimNext({ scope: "scope-b" }))?.id).toBe(inB.id);
      expect(await queue.claimNext({ scope: "scope-b" })).toBeNull();
      expect((await getRow(inA.id)).status).toBe(QueueStatus.Queued);
    });

    it("never hands the same item to two concurrent claimers", async () => {
      await queue.addItem({ step: "one" });
      await queue.addItem({ step: "two" });

      const [first, second] = await Promise.all([
        queue.claimNext(),
        queue.claimNext(),
      ]);

      expect(first!.id).not.toBe(second!.id);
    });

    it("settles an unparseable payload as FAILED and says which item", async () => {
      const id = await insertRaw({ step: 7 });

      const err = await queue.claimNext().catch((e) => e);

      expect(err).toBeInstanceOf(PgQueueDataError);
      expect(err.itemId).toBe(id);
      // Left PROCESSING it would be a claim nothing clears.
      expect((await getRow(id)).status).toBe(QueueStatus.Failed);
    });
  });

  describe("getItem", () => {
    it("reads an item without touching its status", async () => {
      const created = await queue.addItem({ step: "start" });

      const read = await queue.getItem(created.id);

      expect(read).toEqual(created);
      expect((await getRow(created.id)).status).toBe(QueueStatus.Queued);
      expect((await getRow(created.id)).attemptCount).toBe(0);
    });

    it("reads a claimed item, which is how a caller resumes one", async () => {
      const created = await queue.addItem({ step: "start" });
      await queue.claimNext();

      expect(await queue.getItem(created.id)).toMatchObject({
        status: QueueStatus.Processing,
        attemptCount: 1,
      });
    });

    it("returns null when there is no such row", async () => {
      expect(await queue.getItem(MISSING_ID)).toBeNull();
    });

    it("throws on an unparseable payload, leaving the row alone", async () => {
      const id = await insertRaw({ step: 7 });

      await expect(queue.getItem(id)).rejects.toThrow(PgQueueDataError);
      // A read settles nothing, even one that fails.
      expect((await getRow(id)).status).toBe(QueueStatus.Queued);
    });
  });

  describe("updateItem", () => {
    it("marks a claimed item DONE and returns it", async () => {
      const created = await queue.addItem({ step: "start" });
      await queue.claimNext();

      const updated = await queue.updateItem(created.id, done);

      expect(updated).toMatchObject({
        id: created.id,
        status: QueueStatus.Done,
        data: { step: "start" },
      });
      expect((await getRow(created.id)).status).toBe(QueueStatus.Done);
    });

    it("writes status and newState together", async () => {
      const created = await queue.addItem({ step: "start" });

      const updated = await queue.updateItem(created.id, {
        status: { value: QueueStatus.Failed },
        newState: { step: "gave up" },
      });

      expect(updated?.data).toEqual({ step: "gave up" });
      const row = await getRow(created.id);
      expect(row.status).toBe(QueueStatus.Failed);
      expect(row.data).toEqual({ step: "gave up" });
    });

    it("re-queues the item at requeueAt", async () => {
      const created = await queue.addItem({ step: "start" });
      await queue.claimNext();
      const requeueAt = new Date(Date.now() - 1000);

      await queue.updateItem(created.id, {
        status: { value: QueueStatus.Queued, requeueAt },
      });

      expect((await getRow(created.id)).enteredQueueAt.getTime()).toBe(
        requeueAt.getTime(),
      );
      // Due again, so the next claim picks it up on a second attempt.
      expect((await queue.claimNext())?.attemptCount).toBe(2);
    });

    it("leaves entered_queue_at alone when the item is settled", async () => {
      const created = await queue.addItem({ step: "start" });
      const before = (await getRow(created.id)).enteredQueueAt;

      await queue.updateItem(created.id, done);

      expect((await getRow(created.id)).enteredQueueAt.getTime()).toBe(
        before.getTime(),
      );
    });

    it("returns null when there is no such row", async () => {
      expect(await queue.updateItem(MISSING_ID, done)).toBeNull();
    });

    it("refuses a newState the schema rejects, writing nothing", async () => {
      const created = await queue.addItem({ step: "start" });

      await expect(
        queue.updateItem(created.id, {
          ...done,
          newState: { step: 7 } as unknown as Payload,
        }),
      ).rejects.toThrow(z.ZodError);

      const row = await getRow(created.id);
      expect(row.status).toBe(QueueStatus.Queued);
      expect(row.data).toEqual({ step: "start" });
    });
  });

  describe("dataSchema", () => {
    it("refuses a payload it rejects, inserting nothing", async () => {
      await expect(
        queue.addItem({ step: 7 } as unknown as Payload),
      ).rejects.toThrow(z.ZodError);

      const { rows } = await pool.query(`SELECT count(*) AS n FROM ${TABLE}`);
      expect(rows[0].n).toBe("0");
    });

    it("stores what the schema parsed, not what the caller passed", async () => {
      const created = await queue.addItem({
        step: "start",
        extra: "dropped",
      } as unknown as Payload);

      expect(created.data).toEqual({ step: "start" });
      expect((await getRow(created.id)).data).toEqual({ step: "start" });
    });

    it("settles an unparseable payload as FAILED out of processNext", async () => {
      const id = await insertRaw({ step: 7 });
      let ran = false;

      const err = await queue
        .processNext(async () => {
          ran = true;
          return done;
        })
        .catch((e) => e);

      // No handler can run on a payload that does not parse.
      expect(ran).toBe(false);
      expect(err).toBeInstanceOf(PgQueueDataError);
      expect((await getRow(id)).status).toBe(QueueStatus.Failed);
    });

    it("keeps the rejection as the error's cause", async () => {
      const id = await insertRaw({ step: 7 });

      const err = await queue.getItem(id).catch((e) => e);

      expect(err.cause).toBeInstanceOf(z.ZodError);
    });
  });

  describe("client", () => {
    it("runs on a plain pg.Client, with no pool involved", async () => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();

      try {
        const onClient = new PgQueue({
          client,
          table: TABLE,
          dataSchema: Payload,
        });

        const created = await onClient.addItem({ step: "start" });
        const claimed = await onClient.claimNext();
        expect(claimed?.id).toBe(created.id);

        const updated = await onClient.updateItem(created.id, done);
        expect(updated?.status).toBe(QueueStatus.Done);
      } finally {
        await client.end();
      }
    });
  });
});

describe.skipIf(!databaseUrl)("createMigration applied", () => {
  // Names that only work if the migration quotes what it interpolates.
  const SCHEMA = `queue_test_schema_${Date.now().toString(36)}`;
  const QUOTED_TABLE = `pg_queue "quoted" ${Date.now().toString(36)}`;

  // What the migration has to produce for its own name, written out by hand.
  const REF = `"${SCHEMA}"."${QUOTED_TABLE.replaceAll('"', '""')}"`;

  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(createMigration(QUOTED_TABLE, SCHEMA));
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  it("creates the queue's columns, and only those", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [SCHEMA, QUOTED_TABLE],
    );

    expect(
      rows.map((row) => [row.column_name, row.data_type, row.is_nullable]),
    ).toEqual([
      ["id", "uuid", "NO"],
      ["scope", "text", "NO"],
      ["status", "text", "NO"],
      ["data", "jsonb", "NO"],
      ["entered_queue_at", "timestamp with time zone", "NO"],
      ["updated_at", "timestamp with time zone", "NO"],
      ["attempt_count", "integer", "NO"],
    ]);
  });

  it("defaults a new row to queued, unattempted and due now", async () => {
    const { rows } = await pool.query(
      `INSERT INTO ${REF} (scope, data)
       VALUES ('', '{}'::jsonb)
       RETURNING id, status, attempt_count AS "attemptCount",
                 entered_queue_at AS "enteredQueueAt"`,
    );

    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attemptCount).toBe(0);
    expect(rows[0].enteredQueueAt).toBeInstanceOf(Date);
  });

  it("indexes the columns a claim orders and filters by", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2
       ORDER BY indexname`,
      [SCHEMA, QUOTED_TABLE],
    );

    expect(rows.map((row) => row.indexname)).toContain(
      `${QUOTED_TABLE}_scope_status_entered_queue_at_idx`,
    );
    expect(rows.map((row) => row.indexname)).toContain(
      `${QUOTED_TABLE}_status_entered_queue_at_idx`,
    );
  });

  it("holds a queue the library can drive end to end", async () => {
    const queue = new PgQueue({
      client: pool,
      schema: SCHEMA,
      table: QUOTED_TABLE,
      scope: "scoped",
      dataSchema: Payload,
    });

    const created = await queue.addItem({ step: "start" });
    expect(created.scope).toBe("scoped");

    const claimed = await queue.processNext(async () => done);
    expect(claimed?.id).toBe(created.id);
    expect((await queue.getItem(created.id))?.status).toBe(QueueStatus.Done);
  });
});
