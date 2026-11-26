// megaui-only: workspace-wide settings domain barrel.
import type { Database } from "@megaui/database";

import { createSiteSettingsService, type SiteSettingsService } from "./site-settings";

export {
  CODE_README_MAX_LENGTH,
  createSiteSettingsService,
  type CodeReadmeSetting,
  type SetCodeReadmeInput,
  type SiteSettingsService,
} from "./site-settings";

export interface SiteSettingsDomain {
  siteSettings: SiteSettingsService;
}

/** Wires the site-settings service against one `Database`. */
export function createSiteSettingsDomain(database: Database): SiteSettingsDomain {
  return { siteSettings: createSiteSettingsService(database) };
}
