import sql, { empty, raw, type Sql } from "sql-template-tag";
import type { z } from "zod";

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
    error          String?

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

  /**
   * What went wrong, for an update that is an item going badly: a failure, or a
   * re-queue after one.
   */
  error?: Error;
};

// A claimed item, normalized to fixed field names. `id` is the queue row's
// primary key (used for status updates); `data` is its JSON payload, parsed by
// the queue's schema.
export type PgQueueItem<T = unknown> = {
  id: string;
  scope: string;
  data: T;
  status: QueueStatus;
  enteredQueueAt: Date;
  attemptCount: number;
  /**
   * The message of the `error` its last update carried, or null
   */
  error: string | null;
};

/**
 * Anything that runs parameterized SQL and hands back rows.
 *
 * Narrow on purpose: a `pg.Pool` satisfies it, and so do a `pg.Client` and an
 * in-process Postgres such as PGlite. The queue runs one statement at a time
 * and never holds a session open across calls, so a pool buys it nothing that
 * this one method does not.
 */
export interface PgQueueClient {
  query(
    text: string,
    values: Array<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type PgQueueConfig<T> = {
  client: PgQueueClient;
  /**
   * Parses a row's `data`. Required: every payload the queue writes is checked
   * against it first, and every payload it reads back comes through it, so a
   * `PgQueueItem<T>` is a payload that has been validated rather than one that
   * was asserted to be a `T` on the way out of the database.
   */
  dataSchema: z.ZodType<T>;
  table: string;
  scope?: string;
  /** Postgres schema holding `table`. Unqualified when omitted. */
  schema?: string;
};

export type PgQueueItemHandler<T> = (
  item: PgQueueItem<T>,
) => Promise<QueueStateUpdate<T>>;

/** A stored `data` payload that `dataSchema` rejects. */
export class PgQueueDataError extends Error {
  readonly itemId: string;

  constructor(itemId: string, cause: unknown) {
    super(`queue item ${itemId}: data does not match the queue's schema`, {
      cause,
    });
    this.name = "PgQueueDataError";
    this.itemId = itemId;
  }
}

/** A caught value as the `Error` an update carries. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** Quotes an identifier, doubling any quote inside it. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `"schema"."table"`, or `"table"` alone when there is no schema. */
function qualify(table: string, schema?: string): string {
  const prefix = schema?.trim() ? `${quoteIdent(schema.trim())}.` : "";
  return `${prefix}${quoteIdent(table)}`;
}

/*
 * Creates a migration string.
 */
export function createMigration(table: string, schema?: string) {
  const ref = qualify(table, schema);

  return `
CREATE TABLE ${ref} (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  data             jsonb       NOT NULL,
  entered_queue_at timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  attempt_count    integer     NOT NULL DEFAULT 0,
  error            text
);

CREATE INDEX ${quoteIdent(`${table}_status_entered_queue_at_idx`)}
  ON ${ref} (status, entered_queue_at);

CREATE INDEX ${quoteIdent(`${table}_scope_status_entered_queue_at_idx`)}
  ON ${ref} (scope, status, entered_queue_at);
`;
}

// Every statement here hands back the whole row, under the field names
// `PgQueueItem` uses. `updated_at` is left out: it is the claim's own clock,
// written but never read.
const COLUMNS = raw(`
        id AS "id",
        scope AS "scope",
        data AS "data",
        status AS "status",
        entered_queue_at AS "enteredQueueAt",
        attempt_count AS "attemptCount",
        error AS "error"`);

// A row as Postgres hands it back: a `PgQueueItem` whose `data` has not been
// through `dataSchema` yet.
type QueueRow = Omit<PgQueueItem, "data"> & { data: unknown };

/**
 * A Postgres-backed work queue using `SELECT ... FOR UPDATE SKIP LOCKED` for
 * exclusive, concurrency-safe claims.
 *
 * The table name is configurable, but the queue's columns are fixed:
 * `id`, `scope`, `data`, `status`, `entered_queue_at`, `updated_at`,
 * `attempt_count`, `error`.
 *
 * `processNext` is the whole job -- claim, run, settle -- for a caller that
 * wants one. A caller that needs the three apart, because what it does between
 * them is its own business, has `claimNext`, `getItem` and `updateItem`.
 */
export class PgQueue<T = unknown> {
  private readonly client: PgQueueClient;
  private readonly dataSchema: z.ZodType<T>;
  private readonly ref: Sql;
  private readonly scope: string;

  constructor(config: PgQueueConfig<T>) {
    this.client = config.client;
    this.dataSchema = config.dataSchema;
    this.ref = raw(qualify(config.table, config.schema));
    this.scope = config.scope ?? "";
  }

  /**
   * Insert a new queued item and return it. The row's `id` comes from the
   * table's default. Pass `enqueueAt` to defer the item until that time.
   *
   * `data` is parsed before the insert, so a payload the queue could not read
   * back never reaches the table.
   */
  async addItem(
    data: T,
    opts?: {
      scope?: string;
      enqueueAt?: Date;
    },
  ): Promise<PgQueueItem<T>> {
    const payload = this.dataSchema.parse(data);

    const rows = await this.query(sql`
      INSERT INTO ${this.ref}
        (scope, data, status, entered_queue_at, updated_at, attempt_count)
      VALUES (
        ${opts?.scope ?? this.scope},
        ${JSON.stringify(payload)},
        ${QueueStatus.Queued},
        COALESCE(${opts?.enqueueAt ?? null}, now()),
        now(),
        0
      )
      RETURNING ${COLUMNS}
    `);

    return this.parseRow(rows[0]!);
  }

  /**
   * Read one item by id, leaving its status alone. Returns null when there is
   * no such row.
   */
  async getItem(id: string): Promise<PgQueueItem<T> | null> {
    const rows = await this.query(sql`
      SELECT ${COLUMNS}
      FROM ${this.ref}
      WHERE id = ${id}
    `);

    const row = rows[0];
    return row ? this.parseRow(row) : null;
  }

  /**
   * Atomically claim the oldest due item and hand it back, PROCESSING and
   * unsettled. Returns null when the queue is empty.
   *
   * For a caller that cannot say an item's fate by the time it returns from a
   * handler -- one that hands the work to something else, or settles several
   * items at once. Nothing else will settle the item, so the caller owes it an
   * `updateItem`; until then it is a claim no other worker can take.
   */
  async claimNext(opts?: { scope?: string }): Promise<PgQueueItem<T> | null> {
    const row = await this.claim(opts?.scope ?? this.scope);
    if (!row) return null;

    try {
      return this.parseRow(row);
    } catch (err) {
      // It will not parse on a later attempt either, and an item left
      // PROCESSING is a claim nothing clears.
      await this.writeUpdate(row.id, {
        status: { value: QueueStatus.Failed },
        error: asError(err),
      });
      throw err;
    }
  }

  /**
   * Write an item's fate directly: DONE/FAILED, or re-queued at `requeueAt`,
   * optionally replacing `data` with `newState`. Returns the updated item, or
   * null when there is no row with that id.
   *
   * The other half of `claimNext`, and the same write `processNext` makes from
   * what a handler returns.
   */
  async updateItem(
    id: string,
    update: QueueStateUpdate<T>,
  ): Promise<PgQueueItem<T> | null> {
    const row = await this.writeUpdate(id, update);
    return row ? this.parseRow(row) : null;
  }

  /**
   * Claim the next due item and run `handler` on it. The handler's returned
   * `QueueStateUpdate` decides the item's fate: DONE/FAILED, or re-queued at
   * `requeueAt`, optionally replacing the item's `data` with `newState`. On a
   * thrown error the item is marked FAILED. When `scope` is given, only items
   * in that scope are considered. Returns the claimed item, or null when the
   * queue is empty.
   *
   * An item whose stored `data` does not parse is marked FAILED -- no handler
   * can be run on it -- and the `PgQueueDataError` is thrown rather than
   * swallowed, since a payload the schema rejects usually means the two sides
   * of the queue disagree about what it carries.
   */
  async processNext(
    handler: PgQueueItemHandler<T>,
    opts?: {
      scope?: string;
    },
  ): Promise<PgQueueItem<T> | null> {
    const item = await this.claimNext(opts);
    if (!item) return null;

    try {
      const update = await handler({ ...item });
      await this.writeUpdate(item.id, update);
    } catch (err) {
      await this.writeUpdate(item.id, {
        status: { value: QueueStatus.Failed },
        error: asError(err),
      });
    }

    return item;
  }

  /**
   * Atomically claim the oldest due queued item.
   */
  private async claim(scope: string): Promise<QueueRow | null> {
    const rows = await this.query(sql`
      UPDATE ${this.ref}
      SET status = ${QueueStatus.Processing},
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = (
        SELECT id
        FROM ${this.ref}
        WHERE status = ${QueueStatus.Queued}
          AND entered_queue_at <= now()
          AND scope = ${scope}
        ORDER BY entered_queue_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING ${COLUMNS}
    `);

    return rows[0] ?? null;
  }

  private async writeUpdate(
    itemId: string,
    update: QueueStateUpdate<T>,
  ): Promise<QueueRow | undefined> {
    const { status } = update;
    const requeue =
      status.value === QueueStatus.Queued
        ? sql`, entered_queue_at = ${status.requeueAt}`
        : empty;
    const newData =
      update.newState === undefined
        ? empty
        : sql`, data = ${JSON.stringify(this.dataSchema.parse(update.newState))}`;

    const rows = await this.query(sql`
      UPDATE ${this.ref}
      SET status = ${status.value},
          updated_at = now(),
          error = ${update.error?.message ?? null}
          ${requeue}
          ${newData}
      WHERE id = ${itemId}
      RETURNING ${COLUMNS}
    `);

    return rows[0];
  }

  private async query(query: Sql): Promise<Array<QueueRow>> {
    const { rows } = await this.client.query(query.text, query.values);
    return rows as Array<QueueRow>;
  }

  private parseRow(row: QueueRow): PgQueueItem<T> {
    try {
      return { ...row, data: this.dataSchema.parse(row.data) };
    } catch (err) {
      throw new PgQueueDataError(row.id, err);
    }
  }
}

export function catchAndRetry<T>(
  handler: PgQueueItemHandler<T>,
  opts?: {
    maxRetries?: number;
    baseBackoffMs?: number;
    backoffFactor?: number;
  },
): PgQueueItemHandler<T> {
  const {
    maxRetries = 10,
    baseBackoffMs = 1000,
    backoffFactor = 1.5,
  } = opts ?? {};
  return async (item: PgQueueItem<T>): Promise<QueueStateUpdate<T>> => {
    try {
      const update = await handler(item);
      return update;
    } catch (e) {
      const error = asError(e);

      if (item.attemptCount > maxRetries) {
        return { status: { value: QueueStatus.Failed }, error };
      }

      const delayMs = baseBackoffMs * backoffFactor ** (item.attemptCount - 1);
      return {
        status: {
          value: QueueStatus.Queued,
          requeueAt: new Date(new Date().getTime() + delayMs),
        },
        error,
      };
    }
  };
}
