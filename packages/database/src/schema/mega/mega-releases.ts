// megaui:libs/database/schema/pg/mega-releases.ts@0ff3a9d
//
// Ported for PK-05 (REF-07). SaaS tables intentionally omitted at package scope.
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { megaReleaseStatuses } from "./constants";
import { user } from "../auth/user";

export { megaReleaseStatuses };
export type { MegaReleaseStatus } from "./constants";

/**
 * Releases domain metadata (CE-19).
 * Release note bodies live in mega_content with container_type=release_note.
 */
export const megaReleases = pgTable(
  "mega_releases",
  {
    id: text("id").primaryKey(),
    tag: text("tag").notNull(),
    title: text("title").notNull(),
    sha: text("sha").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    prerelease: boolean("prerelease").notNull().default(false),
    major: boolean("major").notNull().default(false),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    commitsSince: integer("commits_since").notNull().default(0),
    sinceTag: text("since_tag"),
    status: text("status").notNull().default(megaReleaseStatuses.DRAFT),
  },
  (table) => [uniqueIndex("mega_releases_tag_uidx").on(table.tag)],
);

export type MegaRelease = InferSelectModel<typeof megaReleases>;
export type NewMegaRelease = InferInsertModel<typeof megaReleases>;
