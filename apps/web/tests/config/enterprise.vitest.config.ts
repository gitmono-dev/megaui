// megaui-only (FS-92): focused tests never load an actual workspace .env.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import base from "../../../../vitest.config";

export default defineConfig({
  ...base,
  envDir: false,
  test: {
    ...base.test,
    setupFiles: [fileURLToPath(new URL("../../../../tests/setup-localstorage.ts", import.meta.url))],
  },
});
