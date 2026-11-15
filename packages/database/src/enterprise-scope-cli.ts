// megaui-only: command-line entry for the migration-target precheck.
//
// Kept apart from `enterprise-scope.ts` so that the library stays free of
// process-level side effects (`process.exit`) and can be bundled for the Edge
// runtime that the Next.js middleware imports it through.
import { runMigrationPrecheck } from "./enterprise-scope";

runMigrationPrecheck().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  },
);
