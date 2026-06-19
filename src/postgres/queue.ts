import pg from "pg";
import sql, { empty, raw } from "sql-template-tag";

/*
Fixed-schema queue w/ JSON payload.

Prisma model:

  model QueueItem {
    id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
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
*/

/*
TODO: Add timeout logic. Figure out how to get automatic retry to happen when
e.g. a process dies.

Probably:
- When pulling data, instead of setting status to "processing", push back the
  timer (and maybe set UUID or hash?).
- Then, when doing state update on completion, ensure attempt count (or maybe a hash
  or smthn) is the same as it was when reading
*/

/*
TODO: Add table name escaping
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
  scope?: string;
  schema?: string;
};

/*
 * Creates a migration string.
 */
export function createMigration(table: string, schema?: string) {
  const escapedName = `${table.replace('"', '""')}`;
  const escapedSchemaPrefix = schema?.trim()
    ? `"${schema.trim().replace('"', '""')}"`
    : "";

  return `
CREATE TABLE ${escapedSchemaPrefix}"${escapedName}" (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  data             jsonb       NOT NULL,
  entered_queue_at timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  attempt_count    integer     NOT NULL DEFAULT 0
);

CREATE INDEX "${table}_status_entered_queue_at_idx"
  ON ${escapedSchemaPrefix}"${table}" (status, entered_queue_at);

CREATE INDEX "${table}_scope_status_entered_queue_at_idx"
  ON ${escapedSchemaPrefix}"${table}" (scope, status, entered_queue_at);
`;
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
  private readonly tableRef: string;
  private readonly scope: string;

  constructor(config: PgQueueConfig) {
    this.pool = config.pool;
    this.table = `"${config.table.replace('"', '""')}"`;
    const schemaPrefix = config.schema?.trim()
      ? `"${config.schema.trim().replace('"', '""')}".`
      : "";
    this.tableRef = `${schemaPrefix}${this.table}`;
    this.scope = config.scope ?? "";
  }

  /**
   * Insert a new queued item and return it. The row's `id` comes from the
   * table's default. Pass `enqueueAt` to defer the item until that time.
   */
  async addItem(
    data: T,
    opts?: {
      scope?: string;
      enqueueAt?: Date;
    },
  ): Promise<PgQueueItem<T>> {
    const { rows } = await this.pool.query<PgQueueItem<T>>(sql`
      INSERT INTO ${raw(this.tableRef)}
        (scope, data, status, entered_queue_at, updated_at, attempt_count)
      VALUES (
        ${opts?.scope ?? this.scope},
        ${JSON.stringify(data)},
        ${QueueStatus.Queued},
        COALESCE(${opts?.enqueueAt ?? null}, now()),
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
    opts?: {
      scope?: string;
    },
  ): Promise<PgQueueItem<T> | null> {
    const { scope = this.scope } = opts ?? {};
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
   * Atomically claim the oldest due queued item.
   */
  private async claim(scope: string): Promise<PgQueueItem<T> | null> {
    const { rows } = await this.pool.query<PgQueueItem<T>>(sql`
      UPDATE ${raw(this.tableRef)}
      SET status = ${QueueStatus.Processing},
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = (
        SELECT id
        FROM ${raw(this.tableRef)}
        WHERE status = ${QueueStatus.Queued}
          AND entered_queue_at <= now()
          AND scope = ${scope}
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
      UPDATE ${raw(this.tableRef)}
      SET status = ${status.value},
          updated_at = now()
          ${requeue}
          ${newData}
      WHERE id = ${itemId}
    `);
  }
}

export function catchAndRetry() {}
