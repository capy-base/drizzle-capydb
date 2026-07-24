import { describe, expect, it } from "vitest";

import { stripLibpqTLSParams } from "../src/index";

const HOST = "proj.db.capydb.dev";

describe("stripLibpqTLSParams", () => {
  it("keeps sslmode, which postgres-js understands", () => {
    const url = `postgres://u:p@${HOST}:6432/db?sslmode=verify-full`;
    expect(stripLibpqTLSParams(url)).toBe(url);
  });

  it("removes sslrootcert, which postgres-js would send as a startup parameter", () => {
    // This is the exact shape a user gets by copying a working psql URL:
    // libpq consumes sslrootcert locally, postgres-js forwards it on the wire,
    // and the pooled endpoint answers 08P01 (or the direct endpoint fails with
    // "unrecognized configuration parameter").
    const got = stripLibpqTLSParams(
      `postgres://u:p@${HOST}:6432/db?sslmode=verify-full&sslrootcert=system`,
    );
    expect(got).toContain("sslmode=verify-full");
    expect(got).not.toContain("sslrootcert");
  });

  it("removes every libpq-only TLS parameter", () => {
    const got = stripLibpqTLSParams(
      `postgres://u:p@${HOST}:5432/db?sslmode=verify-full&sslrootcert=system` +
        `&sslcert=/c.pem&sslkey=/k.pem&sslcrl=/l.pem&sslcompression=0&channel_binding=require`,
    );
    for (const removed of [
      "sslrootcert",
      "sslcert",
      "sslkey",
      "sslcrl",
      "sslcompression",
      "channel_binding",
    ]) {
      expect(got).not.toContain(removed);
    }
    expect(got).toContain("sslmode=verify-full");
  });

  it("preserves unrelated parameters and the rest of the URL", () => {
    const got = stripLibpqTLSParams(
      `postgres://u:p@${HOST}:6432/db?sslmode=verify-full&sslrootcert=system&application_name=api`,
    );
    expect(got).toContain("application_name=api");
    expect(got).toContain(`${HOST}:6432/db`);
    expect(got).toContain("u:p@");
  });

  it("is a no-op for URLs with no query string", () => {
    const url = `postgres://u:p@${HOST}:6432/db`;
    expect(stripLibpqTLSParams(url)).toBe(url);
  });

  it("leaves unparseable connection strings untouched", () => {
    // libpq keyword/value form is not a URL; corrupting it would be worse than
    // leaving a parameter in place.
    const kv = "host=proj.db.capydb.dev port=6432 sslmode=verify-full sslrootcert=system";
    expect(stripLibpqTLSParams(kv)).toBe(kv);
  });

  it("is case-insensitive on parameter names", () => {
    const got = stripLibpqTLSParams(`postgres://u:p@${HOST}:6432/db?SSLRootCert=system`);
    expect(got.toLowerCase()).not.toContain("sslrootcert");
  });
});
