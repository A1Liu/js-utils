import pg from "pg";
import sql, { empty, raw } from "sql-template-tag";

/*
The queue table's name is configurable, but its columns are fixed. The indexes
match claim()'s access pattern: filter on status (and optionally scope), then
order by entered_queue_at.

Example Prisma model:

  model QueueItem {
    id             String   @id @default(uuid()) @db.Uuid
    scope          String
    data           Json
    status         String   @default("queued")
    enteredQueueAt DateTime @default(now()) @map("entered_queue_at") @db.Timestamptz(6)
    updatedAt      DateTime @default(now()) @map("updated_at") @db.Timestamptz(6)
    attemptCount   Int      @default(0) @map("attempt_count")

    @@index([status, enteredQueueAt])
    @@index([scope, status, enteredQueueAt])
    @@map("queue_items")
  }

Example Postgres migration:

  CREATE TABLE queue_items (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope            text        NOT NULL,
    data             jsonb       NOT NULL,
    status           text        NOT NULL DEFAULT 'queued',
    entered_queue_at timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    attempt_count    integer     NOT NULL DEFAULT 0
  );

  CREATE INDEX queue_items_status_entered_queue_at_idx
    ON queue_items (status, entered_queue_at);

  CREATE INDEX queue_items_scope_status_entered_queue_at_idx
    ON queue_items (scope, status, entered_queue_at);
*/

export enum QueueStatus {
  Queued = "queued",
  Processing = "processing",
  Done = "done",
  Failed = "failed",
}

export type QueueStateUpdate<T> = {
  status:
    | { value: QueueStatus.Done | QueueStatus.Failed }
    | {
        value: QueueStatus.Queued;
        requeueAt: Date;
      };

  newState?: T;
};

// Error which prevents queue retry — the item goes straight to FAILED.

// A claimed item, normalized to fixed field names. `id` is the queue row's
// primary key (used for status updates); `data` is its JSON payload.
export type PgQueueItem<T = unknown> = {
  id: string;
  scope: string;
  data: T;
  status: QueueStatus;
  enteredQueueAt: Date;
  attemptCount: number;
};

export type PgQueueConfig = {
  pool: pg.Pool;
  table: string;
};

export function createMigration(table: string) {
  return `
      CREATE TABLE ${table} (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        scope            text        NOT NULL,
        data             jsonb       NOT NULL,
        status           text        NOT NULL DEFAULT 'queued',
        entered_queue_at timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        attempt_count    integer     NOT NULL DEFAULT 0
      )
    `
}

/**
 * A Postgres-backed work queue using `SELECT ... FOR UPDATE SKIP LOCKED` for
 * exclusive, concurrency-safe claims.
 *
 * The table name is configurable, but the queue's columns are fixed:
 * `id`, `scope`, `data`, `status`, `entered_queue_at`, `updated_at`,
 * `attempt_count`.
 */
export class PgQueue<T = unknown> {
  private readonly pool: pg.Pool;
  private readonly table: string;

  constructor(config: PgQueueConfig) {
    this.pool = config.pool;
    this.table = config.table;
  }

  /**
   * Insert a new queued item and return it. The row's `id` comes from the
   * table's default. Pass `enqueueAt` to defer the item until that time.
   */
  async addItem(
    scope: string,
    data: T,
    enqueueAt?: Date,
  ): Promise<PgQueueItem<T>> {
    const { rows } = await this.pool.query<PgQueueItem<T>>(sql`
      INSERT INTO ${raw(this.table)}
        (scope, data, status, entered_queue_at, updated_at, attempt_count)
      VALUES (
        ${scope},
        ${JSON.stringify(data)},
        ${QueueStatus.Queued},
        COALESCE(${enqueueAt ?? null}, now()),
        now(),
        0
      )
      RETURNING
        id AS "id",
        scope AS "scope",
        data AS "data",
        status AS "status",
        entered_queue_at AS "enteredQueueAt",
        attempt_count AS "attemptCount"
    `);

    return rows[0]!;
  }

  /**
   * Claim the next due item and run `handler` on it. The handler's returned
   * `QueueStateUpdate` decides the item's fate: DONE/FAILED, or re-queued at
   * `requeueAt`, optionally replacing the item's `data` with `newState`. On a
   * thrown error the item is marked FAILED. When `scope` is given, only items
   * in that scope are considered. Returns the claimed item, or null when the
   * queue is empty.
   */
  async processNext(
    handler: (item: PgQueueItem<T>) => Promise<QueueStateUpdate<T>>,
    scope?: string,
  ): Promise<PgQueueItem<T> | null> {
    const item = await this.claim(scope);
    if (!item) return null;

    try {
      const update = await handler({ ...item });
      await this.applyUpdate(item.id, update);
    } catch (err) {
      await this.applyUpdate(item.id, {
        status: { value: QueueStatus.Failed },
      });
    }

    return item;
  }

  /**
   * Atomically claim the oldest due queued item. The `FOR UPDATE SKIP LOCKED`
   * subquery picks one unlocked queued row ordered by `entered_queue_at`; the
   * surrounding UPDATE flips it to PROCESSING in the same statement, so no two
   * workers can grab the same row. `entered_queue_at <= now()` keeps
   * backoff-deferred items from being picked up early.
   */
  private async claim(scope?: string): Promise<PgQueueItem<T> | null> {
    const scopeFilter =
      scope === undefined ? empty : sql` AND scope = ${scope}`;

    const { rows } = await this.pool.query<PgQueueItem<T>>(sql`
      UPDATE ${raw(this.table)}
      SET status = ${QueueStatus.Processing},
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = (
        SELECT id
        FROM ${raw(this.table)}
        WHERE status = ${QueueStatus.Queued}
          AND entered_queue_at <= now()
          ${scopeFilter}
        ORDER BY entered_queue_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id AS "id",
        scope AS "scope",
        data AS "data",
        status AS "status",
        entered_queue_at AS "enteredQueueAt",
        attempt_count AS "attemptCount"
    `);

    return rows[0] ?? null;
  }

  private async applyUpdate(
    itemId: string,
    update: QueueStateUpdate<T>,
  ): Promise<void> {
    const { status } = update;
    const requeue =
      status.value === QueueStatus.Queued
        ? sql`, entered_queue_at = ${status.requeueAt}`
        : empty;
    const newData =
      update.newState === undefined
        ? empty
        : sql`, data = ${JSON.stringify(update.newState)}`;

    await this.pool.query(sql`
      UPDATE ${raw(this.table)}
      SET status = ${status.value},
          updated_at = now()
          ${requeue}
          ${newData}
      WHERE id = ${itemId}
    `);
  }
}
