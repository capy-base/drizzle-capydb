/**
 * @capydb/drizzle - Drizzle ORM helpers for CapyDB.
 *
 * A thin, typed convenience layer over `drizzle-orm/postgres-js` + `postgres`
 * (both peer dependencies) that encodes CapyDB's operational rules so you
 * don't have to remember them:
 *
 * - CapyDB cells expose two endpoints on `*.db.capydb.dev`: the pooled port
 *   `:6432` (transaction-mode PgBouncer) and the direct port `:5432`.
 * - Through the transaction pooler, server-side prepared statements are
 *   unsafe: the pooler may run each statement of a session on a different
 *   backend connection, so a statement prepared on one backend does not exist
 *   on the next. postgres-js must therefore run with `prepare: false`.
 * - In serverless environments every concurrently-warm function instance
 *   opens its own pool, so per-instance pools must stay tiny (`max: 1`).
 *   The pooler multiplexes those many small pools onto few real backends.
 * - DDL and migrations must use the DIRECT url: transaction pooling breaks
 *   session-level state (advisory locks, `SET`, multi-statement migration
 *   transactions) that migration tools rely on.
 *
 * CapyDB connection strings already carry `sslmode=require`; postgres-js
 * honours it from the URL, so no extra TLS configuration is needed here.
 */
import type { AnyRelations, DrizzleConfig, EmptyRelations } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Options, type PostgresType, type Sql } from "postgres";

/** postgres-js client options as accepted by `postgres(url, options)`. */
type ClientOptions = Options<Record<string, PostgresType>>;

/** The transaction-mode PgBouncer port on CapyDB hosts (`:5432` is direct). */
const POOLED_PORT = "6432";

/** Env vars checked (in order) by {@link createDb} after `options.connectionString`. */
const POOLED_ENV_VARS = ["CAPYDB_DATABASE_URL", "DATABASE_URL"] as const;

/** Env vars checked (in order) by {@link createDirectDb} after `options.connectionString`. */
const DIRECT_ENV_VARS = ["CAPYDB_DATABASE_DIRECT_URL", "DATABASE_DIRECT_URL"] as const;

/**
 * Options for {@link createDb} and {@link createDirectDb}.
 *
 * `relations` and `logger` are forwarded verbatim to drizzle; everything else
 * controls how the underlying postgres-js client is built.
 *
 * Note (drizzle-orm v1): the driver config no longer takes a `schema` map -
 * table objects from your schema file are used directly in queries, and the
 * relational query API (`db.query.*`) is enabled by passing the result of
 * `defineRelations` as `relations`.
 */
export interface CapyDBDrizzleOptions<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Explicit connection string. When set, environment variables are not
   * consulted at all. Useful for scripts and tests.
   */
  connectionString?: string;
  /**
   * Force pooled (`true`) or direct (`false`) client defaults instead of
   * inferring them from the URL's port. You normally never need this: URLs
   * targeting `:6432` are detected automatically. Set `pooled: true` when a
   * transaction pooler sits in front of the database on a non-standard port
   * (the pooler rules still apply even if the port doesn't say so).
   */
  pooled?: boolean;
  /**
   * postgres-js options merged OVER the CapyDB defaults via spread, so any
   * key you set here wins. Careful with `prepare: true` against the pooled
   * endpoint - transaction-mode PgBouncer will hand your session's statements
   * to different backends and prepared statements will randomly not exist.
   */
  client?: ClientOptions;
  /**
   * Relations built with drizzle's `defineRelations`, enabling the relational
   * query API (`db.query.*`). Optional - plain `db.select().from(table)`
   * queries need nothing here.
   */
  relations?: TRelations;
  /** Drizzle logger (or `true` for the default logger), forwarded as-is. */
  logger?: DrizzleConfig["logger"];
  /**
   * Opt into drizzle v1's JIT-compiled result mappers. Worth enabling for
   * hot paths: mapping is compiled once per query shape instead of
   * interpreted per row. Forwarded as-is.
   */
  jit?: DrizzleConfig["jit"];
}

/**
 * Resolve a connection string from an explicit value or a prioritized list of
 * environment variables.
 *
 * Exported for testability and for tools that want the same resolution
 * semantics without constructing a client.
 *
 * @param explicit - `options.connectionString`; wins outright when non-empty.
 * @param envVarNames - environment variable names checked in order; the first
 *   non-empty value wins.
 * @param env - environment map, defaults to `process.env` (injectable for tests).
 * @throws Error naming every checked source when nothing is set, so a
 *   misconfigured deploy fails loudly at startup instead of at first query.
 */
export function resolveConnectionString(
  explicit: string | undefined,
  envVarNames: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  for (const name of envVarNames) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  throw new Error(
    `@capydb/drizzle: no connection string found. Pass \`connectionString\` in options ` +
      `or set one of these environment variables: ${envVarNames.join(", ")}. ` +
      `Run \`capydb env pull\` to populate them from your linked project.`,
  );
}

/**
 * Whether a connection string targets CapyDB's transaction-mode pooler.
 *
 * Detection is by port: `:6432` is the per-cell PgBouncer (transaction
 * pooling), `:5432` is the direct postmaster. Falls back to a conservative
 * regex when the string is not WHATWG-URL-parseable.
 */
export function isPooledUrl(connectionString: string): boolean {
  // Only trust WHATWG URL parsing when there is a real scheme separator:
  // bare "host:6432" would otherwise parse as scheme "host" + path "6432"
  // and report no port at all.
  if (connectionString.includes("://")) {
    try {
      return new URL(connectionString).port === POOLED_PORT;
    } catch {
      // Not URL-parseable after all - fall through to the regex.
    }
  }
  return /:6432(?=[/?]|$)/.test(connectionString);
}

/**
 * Compute the postgres-js options for a connection string.
 *
 * Pooled defaults (`:6432` or `pooled: true`) are `{ prepare: false, max: 1 }`:
 *
 * - `prepare: false` because transaction-mode PgBouncer routes each
 *   transaction to whichever backend is free - a statement prepared on one
 *   backend simply does not exist on the next, producing intermittent
 *   `prepared statement "..." does not exist` errors under load.
 * - `max: 1` because in serverless runtimes every warm instance holds its own
 *   pool; the pooler's job is to multiplex many tiny client pools onto a few
 *   real backend connections, so a big per-instance pool only burns pooler
 *   slots.
 *
 * Direct defaults are `{ max: 10 }` - a long-lived server process talking to
 * the postmaster can safely hold a modest pool and use prepared statements.
 *
 * Caller `overrides` are spread last and win key-by-key.
 *
 * @param connectionString - used for port-based pooled detection.
 * @param pooled - explicit override; `undefined` means "infer from the URL".
 * @param overrides - caller-provided postgres-js options.
 */
export function resolveClientOptions(
  connectionString: string,
  pooled: boolean | undefined,
  overrides?: ClientOptions,
): ClientOptions {
  const usePooledDefaults = pooled ?? isPooledUrl(connectionString);
  const defaults: ClientOptions = usePooledDefaults ? { prepare: false, max: 1 } : { max: 10 };
  return { ...defaults, ...overrides };
}

/** Shared implementation for {@link createDb} and {@link createDirectDb}. */
function createFromSources<TRelations extends AnyRelations>(
  options: CapyDBDrizzleOptions<TRelations>,
  envVarNames: readonly string[],
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  const connectionString = resolveConnectionString(options.connectionString, envVarNames);
  const client = postgres(
    connectionString,
    resolveClientOptions(connectionString, options.pooled, options.client),
  );
  return drizzle<TRelations>({
    client,
    relations: options.relations,
    logger: options.logger,
    jit: options.jit,
  });
}

/**
 * Create a Drizzle database backed by a postgres-js client with CapyDB-safe
 * defaults. This is the client your application code should use.
 *
 * Connection string resolution order:
 * 1. `options.connectionString`
 * 2. `CAPYDB_DATABASE_URL`
 * 3. `DATABASE_URL`
 *
 * (`capydb env pull` writes `DATABASE_URL` pointing at the pooled `:6432`
 * endpoint; some setups also expose `CAPYDB_DATABASE_URL`.)
 *
 * When the resolved URL targets the pooled port - or `options.pooled` is
 * `true` - the client defaults to `{ prepare: false, max: 1 }`. Both are
 * load-bearing behind transaction-mode PgBouncer: prepared statements break
 * because consecutive statements may execute on different backends, and tiny
 * per-instance pools are what let many serverless instances share few real
 * connections. Direct URLs default to `{ max: 10 }`. Anything in
 * `options.client` overrides these defaults.
 *
 * Do NOT run migrations/DDL through this client when it points at the pooled
 * endpoint - use {@link createDirectDb} (or `DATABASE_DIRECT_URL` in your
 * drizzle-kit config) instead.
 *
 * @example
 * ```ts
 * import { createDb } from '@capydb/drizzle'
 * import { users } from './db/schema' // e.g. from `capydb generate drizzle`
 *
 * export const db = createDb()
 * const rows = await db.select().from(users)
 * ```
 *
 * For the relational query API, pass relations:
 * ```ts
 * import { defineRelations } from 'drizzle-orm'
 * import * as schema from './db/schema'
 *
 * const relations = defineRelations(schema, (r) => ({ ... }))
 * export const db = createDb({ relations })
 * ```
 */
export function createDb<TRelations extends AnyRelations = EmptyRelations>(
  options: CapyDBDrizzleOptions<TRelations> = {},
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  return createFromSources(options, POOLED_ENV_VARS);
}

/**
 * Create a Drizzle database on the DIRECT (`:5432`) endpoint, for
 * migrations, DDL, and one-off admin scripts.
 *
 * Connection string resolution order:
 * 1. `options.connectionString`
 * 2. `CAPYDB_DATABASE_DIRECT_URL`
 * 3. `DATABASE_DIRECT_URL`
 *
 * Why a separate entry point: transaction-mode PgBouncer (the pooled `:6432`
 * endpoint) breaks the session-level machinery migration tools depend on -
 * advisory locks used to serialize concurrent migrators, `SET`/`SET LOCAL`,
 * and long multi-statement transactions. DDL must therefore always go over a
 * direct connection; this function makes the safe path the easy path.
 *
 * Defaults to direct-connection settings (`{ max: 10 }`, prepared statements
 * enabled). If the resolved URL somehow points at `:6432` anyway, pooled
 * defaults kick in as a safety net - but fix the env var: migrations against
 * the pooler can deadlock or half-apply.
 *
 * @example
 * ```ts
 * // scripts/migrate.ts
 * import { createDirectDb } from '@capydb/drizzle'
 * import { migrate } from 'drizzle-orm/postgres-js/migrator'
 *
 * const db = createDirectDb()
 * await migrate(db, { migrationsFolder: './drizzle' })
 * await db.$client.end()
 * ```
 */
export function createDirectDb<TRelations extends AnyRelations = EmptyRelations>(
  options: CapyDBDrizzleOptions<TRelations> = {},
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  return createFromSources(options, DIRECT_ENV_VARS);
}
