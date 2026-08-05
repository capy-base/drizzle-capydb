# @capydb/drizzle

Drizzle ORM helpers for [CapyDB](https://capydb.dev). A thin, typed layer over
`drizzle-orm/postgres-js` + `postgres` that bakes in the connection rules a
CapyDB cell expects — so the pooled endpoint, serverless pool sizing, and the
migrations-need-the-direct-url rule are handled for you instead of learned the
hard way.

## Install

`drizzle-orm` (v1, currently the `rc` dist-tag) and `postgres` are peer
dependencies:

```bash
pnpm add @capydb/drizzle drizzle-orm@rc postgres
pnpm add -D drizzle-kit@rc
```

## Quickstart

Link your project and pull its env vars, then create the client:

```bash
capydb link
capydb env pull        # writes DATABASE_URL (pooled) and DATABASE_DIRECT_URL (direct)
capydb generate drizzle # optional: generate a Drizzle schema from the live database
```

```ts
// src/db/index.ts
import { createDb } from '@capydb/drizzle'
import { users } from './schema'

export const db = createDb()

// anywhere in your app
const rows = await db.select().from(users)
```

For drizzle v1's relational query API (`db.query.*`), define relations with
`defineRelations` and pass them in:

```ts
import { defineRelations } from 'drizzle-orm'
import * as schema from './schema'

export const relations = defineRelations(schema, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: schema.posts.userId, to: schema.users.id }) },
}))

export const db = createDb({ relations })
const usersWithPosts = await db.query.users.findMany({ with: { posts: true } })
```

`createDb()` resolves the connection string from, in order:
`options.connectionString`, `CAPYDB_DATABASE_URL`, `DATABASE_URL`. It throws a
descriptive error at startup if none is set.

## Pooled vs direct — why two URLs

Every CapyDB cell exposes two endpoints on `*.db.capydb.dev`:

| Port | What it is | Env var | Use for |
|---|---|---|---|
| `:6432` | Transaction-mode PgBouncer (pooled) | `DATABASE_URL` | Application queries, serverless |
| `:5432` | Direct Postgres connection | `DATABASE_DIRECT_URL` | Migrations, DDL, admin scripts |

Transaction-mode pooling means **each transaction** — not each session — is
assigned to whichever backend connection is free. Two things follow:

1. **Server-side prepared statements break.** A statement prepared on one
   backend does not exist on the next one your session lands on, causing
   intermittent `prepared statement "..." does not exist` errors under load.
   postgres-js must run with `prepare: false` against `:6432`.
2. **Session state doesn't stick.** Advisory locks, `SET`, and long
   multi-statement transactions — exactly what migration tools rely on — are
   not safe through the pooler. **DDL and migrations must use the direct URL.**

`createDb()` detects `:6432` (or `pooled: true`) and defaults the client to
`{ prepare: false, max: 1 }`; direct URLs default to `{ max: 10 }`. Your own
`client` options override any default:

```ts
const db = createDb({ client: { max: 2, idle_timeout: 20 } })
```

Connection strings from CapyDB already include `sslmode=require`; postgres-js
picks TLS up from the URL, so nothing extra is needed.

## Serverless guidance

In serverless runtimes (Vercel, Lambda, Workers with TCP), every
concurrently-warm function instance holds its own connection pool. Keep each
one tiny — the default `max: 1` (or at most `2`) is deliberate. The pooler's
whole job is to multiplex many small client pools onto a few real backend
connections; a large per-instance `max` just exhausts pooler slots. Create the
client once at module scope so warm invocations reuse it:

```ts
// db.ts — module scope, reused across invocations
import { createDb } from '@capydb/drizzle'

export const db = createDb()
```

On hot paths, `createDb({ jit: true })` opts into drizzle v1's JIT-compiled
result mappers (mapping compiled once per query shape).

## Migrations

Use `createDirectDb()` (resolution order: `options.connectionString`,
`CAPYDB_DATABASE_DIRECT_URL`, `DATABASE_DIRECT_URL`) for programmatic
migrations. It rejects a pooled `:6432` URL (or `pooled: true`) before opening
a client, because client flags cannot make transaction-pooled DDL safe:

```ts
// scripts/migrate.ts
import { createDirectDb } from '@capydb/drizzle'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const db = createDirectDb()
await migrate(db, { migrationsFolder: './drizzle' })
await db.$client.end()
```

And point drizzle-kit at the **direct** URL:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // drizzle-kit v1 manages ALL schemas by default; scope push/pull to yours
  // so extension-created schemas (e.g. cron from pg_cron) are never touched.
  schemaFilter: ['public'],
  dbCredentials: {
    // Never the pooled DATABASE_URL: transaction pooling breaks the advisory
    // locks and session state migration tooling depends on.
    url: process.env.DATABASE_DIRECT_URL!,
  },
})
```

## Row-level security context

If your database uses RLS with the vanilla GUC convention (what
`capydb migrate rls` emits when converting Supabase policies), set the
per-request context with `withAuthContext` — it opens a transaction, applies
the context transaction-locally, and runs your callback inside it:

```ts
import { withAuthContext } from '@capydb/drizzle'

const todos = await withAuthContext(db, { userId: session.userId }, (tx) =>
  tx.select().from(schema.todos)
)
```

Why a transaction: `set_config(..., true)` is `SET LOCAL` semantics, which is
the only pooler-safe shape — on the `:6432` endpoint, transaction-mode
PgBouncer may run each statement of a session on a different backend, so a
session-level `SET` would leak one user's identity into another request's
connection. Always query through the `tx` handle inside the callback; `db`
queries run outside the context.

Promoted JWT claims and the claims blob ride along the same way:

```ts
await withAuthContext(
  db,
  { userId, set: { 'app.org_id': orgId }, claims: rawJwtClaims },
  (tx) => tx.select().from(schema.documents)
)
```

For databases converted with `--mode supabase-compat`, use
`withSupabaseJwtClaims(db, claims, callback)` — it sets the whole (verified!)
claims object as `request.jwt.claims` for the `auth.uid()` shim to read.

## API

- `createDb<TRelations>(options?)` — pooled-aware application client. Returns
  `PostgresJsDatabase<TRelations> & { $client: Sql }`.
- `createDirectDb<TRelations>(options?)` — direct-connection client for
  migrations/DDL. Same return type.
- `CapyDBDrizzleOptions<TRelations>` — `{ connectionString?, pooled?, client?, relations?, logger?, jit? }`.
  (drizzle v1 dropped the driver-level `schema`/`casing` options: tables are
  used directly in queries, `db.query.*` comes from `relations`, and casing is
  configured at table level with drizzle's casing helpers.)
- `withAuthContext(db, context, callback)` — runs the callback in a
  transaction with the RLS context applied transaction-locally
  (`app.user_id`, `app.role`, `app.email`, `app.claims`, plus custom GUCs via
  `set`). Pooler-safe by construction.
- `withSupabaseJwtClaims(db, claims, callback)` — same, but sets
  `request.jwt.claims` for databases using the supabase-compat shim.
- `AuthContext` / `AuthContextTransaction<TRelations>` — the context shape and
  the transaction handle type passed to the callbacks.
- `resolveConnectionString(explicit, envVarNames, env?)`,
  `resolveClientOptions(connectionString, pooled, overrides?)`,
  `isPooledUrl(connectionString)` — the pure resolution helpers, exported for
  testing and tooling.

Everything else (query builders, `sql`, migrator, …) comes from `drizzle-orm`
directly — this package deliberately re-exports nothing from it.

## Development

```bash
pnpm install
pnpm build       # tsdown (ESM + CJS) + tsgo declarations
pnpm typecheck
pnpm lint        # oxlint
pnpm test        # vitest
```

## License

MIT
