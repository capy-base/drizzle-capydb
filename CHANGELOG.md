# Changelog

All notable changes to `@capydb/drizzle` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-08-03

### Added

- `withAuthContext(db, context, callback)` — runs queries under a row-level-security context: opens a transaction, applies `app.user_id`/`app.role`/`app.email`/`app.claims` (plus custom GUCs via `set`) with `set_config(..., true)`, and hands the callback the transaction. Transaction-local is the only pooler-safe shape — a session-level `SET` through transaction-mode PgBouncer would leak one user's identity into another request's connection.
- `withSupabaseJwtClaims(db, claims, callback)` — the same, for databases converted with `capydb migrate rls --mode supabase-compat`: sets the verified claims object as `request.jwt.claims` for the `auth.*` shim.
- `AuthContext` interface and `AuthContextTransaction<TRelations>` type.

## [1.2.0] - 2026-07-28

### Added

- `waitForWake(client, options?)` — blocks until the database cell is ready, retrying transient pause/resume errors with exponential backoff.
- `isCellWakingError(error)` — identifies transient cell wake (pause/resume) errors that are safe to retry.
- `stripLibpqTLSParams(connectionString)` — strips libpq-only TLS query parameters (e.g. `sslrootcert`, `sslcert`) that postgres-js would otherwise forward as wire startup parameters, keeping only parameters postgres-js understands.
- `WaitForWakeOptions` interface for configuring `waitForWake` retry behavior.

### Changed

- Connection string handling now sanitizes libpq-only TLS parameters automatically, ensuring compatibility with postgres-js.

## [1.1.0] - 2026-07-22

### Added

- `assertPooledStartupParameters(connection)` — validates postgres-js `connection` options against the pooled (:6432) endpoint's startup-parameter rules: tracked parameters pass through, ignored parameters (`statement_timeout` and friends) emit a warning because the pooler accepts-and-ignores them, and unsupported parameters (e.g. `search_path`) throw so a misconfigured deploy fails loudly at startup instead of with `unsupported startup parameter` (08P01) on every connection.
- `resolveClientOptions` now asserts startup parameters when targeting a pooled connection.

## [1.0.0] - 2026-07-17

### Added

- Initial release: `createDb`/`createDirectDb` factories with pooler-safe transaction-mode defaults (`prepare: false` on :6432), `resolveConnectionString`, `isPooledUrl`, and `resolveClientOptions`.
- `createDirectDb` enforces a direct (non-pooled) connection for migrations.
