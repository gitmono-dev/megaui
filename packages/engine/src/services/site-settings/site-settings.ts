// megaui-only: workspace-wide settings (admin settings page).
//
// The service stores and reads values only. Whether the caller may write is
// decided by the BFF (mega2 admin group) before `setCodeReadme` is called;
// the service still requires a signed-in actor so every write is attributed.
import { MEGA_CODE_README_MAX_LENGTH } from "@megaui/core";
import { megaSiteSettingKeys, megaSiteSettings, type Database } from "@megaui/database";
import { eq } from "drizzle-orm";

import { MegaBadRequestError, MegaUnauthorizedError } from "../../errors";

/** Upper bound on the stored Code root README, in UTF-16 code units. */
export const CODE_README_MAX_LENGTH = MEGA_CODE_README_MAX_LENGTH;

export interface CodeReadmeSetting {
  /** Markdown source; empty when no README is configured. */
  markdown: string;
  /** ISO timestamp of the last write, or `null` when never set. */
  updatedAt: string | null;
  /** User id of the last writer, or `null` when unknown. */
  updatedBy: string | null;
}

export interface SetCodeReadmeInput {
  markdown: string;
  actorUserId: string;
}

export interface SiteSettingsService {
  getCodeReadme(): Promise<CodeReadmeSetting>;
  /** Stores the README; whitespace-only input clears it. */
  setCodeReadme(input: SetCodeReadmeInput): Promise<CodeReadmeSetting>;
}

const EMPTY_CODE_README: CodeReadmeSetting = { markdown: "", updatedAt: null, updatedBy: null };

export function createSiteSettingsService(database: Database): SiteSettingsService {
  const key = megaSiteSettingKeys.CODE_README;

  async function getCodeReadme(): Promise<CodeReadmeSetting> {
    const [row] = await database
      .select()
      .from(megaSiteSettings)
      .where(eq(megaSiteSettings.key, key))
      .limit(1);
    if (!row) return { ...EMPTY_CODE_README };
    return {
      markdown: row.value,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  async function setCodeReadme(input: SetCodeReadmeInput): Promise<CodeReadmeSetting> {
    const actorUserId = input.actorUserId.trim();
    if (!actorUserId) {
      throw new MegaUnauthorizedError("A signed-in session is required");
    }
    if (typeof input.markdown !== "string") {
      throw new MegaBadRequestError("README markdown must be a string");
    }
    if (input.markdown.length > CODE_README_MAX_LENGTH) {
      throw new MegaBadRequestError(
        `README markdown exceeds ${CODE_README_MAX_LENGTH} characters`,
      );
    }

    if (!input.markdown.trim()) {
      await database.delete(megaSiteSettings).where(eq(megaSiteSettings.key, key));
      return { ...EMPTY_CODE_README };
    }

    const now = new Date();
    const [row] = await database
      .insert(megaSiteSettings)
      .values({ key, value: input.markdown, updatedBy: actorUserId, updatedAt: now })
      .onConflictDoUpdate({
        target: megaSiteSettings.key,
        set: { value: input.markdown, updatedBy: actorUserId, updatedAt: now },
      })
      .returning();
    return {
      markdown: row!.value,
      updatedAt: row!.updatedAt.toISOString(),
      updatedBy: row!.updatedBy,
    };
  }

  return { getCodeReadme, setCodeReadme };
}
