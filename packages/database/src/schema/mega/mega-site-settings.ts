// megaui-only: workspace-wide settings edited from the admin settings page.
//
// One row per setting key. The value is stored as text; each key owns its own
// format (the Code root README is Markdown). Writes are admin-only and enforced
// in the BFF before the engine is called.
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { user } from "../auth/user";
import { createdAtColumn, updatedAtColumn } from "../timestamps";

/** Known setting keys. Add a key here before a service reads or writes it. */
export const megaSiteSettingKeys = {
  CODE_README: "code_readme",
} as const;

export type MegaSiteSettingKey = (typeof megaSiteSettingKeys)[keyof typeof megaSiteSettingKeys];

export const megaSiteSettings = pgTable("mega_site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type MegaSiteSetting = InferSelectModel<typeof megaSiteSettings>;
export type NewMegaSiteSetting = InferInsertModel<typeof megaSiteSettings>;
