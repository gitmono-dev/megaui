// megaui:drizzle.config.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-04 task card): single PG
// dialect only (no `drizzle.config.sqlite.ts` counterpart — ADR-ARCH-02),
// schema path/out dir moved under this package (`packages/database`)
// instead of the app-root `libs/database` layout.
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "[@megaui/database] DATABASE_URL is not set. Fail-closed: drizzle-kit needs an explicit connection string (GC-07).",
  );
}

export default defineConfig({
  // Exclude co-located `*.test.ts` files — drizzle-kit would otherwise load
  // vitest and crash (or worse, exit 0 after printing the error).
  schema: "./src/schema/**/!(*.test).ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // The target of a migration is checked before drizzle-kit may connect:
    // `db:migrate` runs the precheck of FS-44 first, and a refused target
    // stays without a single DDL statement.
    url: connectionString,
  },
});
