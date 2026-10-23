/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ENV: string;
      APP_ID_PREFIX_TEAM_BUNDLE: string;
      ADMIN_ACCESS_AUD: string;
      ADMIN_ACCESS_TEAM_DOMAIN: string;
      ANTHROPIC_API_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
