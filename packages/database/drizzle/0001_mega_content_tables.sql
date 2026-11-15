CREATE TABLE "mega_doc_collaborators" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_doc_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"author_id" text NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_doc_stars" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_doc_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"author_id" text NOT NULL,
	"summary" text,
	"snapshot_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"folder_id" text,
	"excerpt" text,
	"author_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_content" (
	"container_type" text NOT NULL,
	"container_id" text NOT NULL,
	"body_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ydoc_state" "bytea",
	"body_format_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mega_content_pk" PRIMARY KEY("container_type","container_id")
);
--> statement-breakpoint
CREATE TABLE "mega_content_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"block_id" text NOT NULL,
	"parent_block_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"variant" text DEFAULT 'paragraph' NOT NULL,
	"text_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_content_links" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"context_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_issue_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_number" integer NOT NULL,
	"author_id" text NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"package_id" text NOT NULL,
	"author_id" text NOT NULL,
	"milestone" jsonb,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watcher_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_cls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_cl_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"cl_number" integer NOT NULL,
	"author_id" text NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_cls" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"link" text,
	"title" text NOT NULL,
	"state" text DEFAULT 'wip' NOT NULL,
	"package_id" text NOT NULL,
	"author_id" text NOT NULL,
	"reviewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ci" text DEFAULT 'queued' NOT NULL,
	"merge" text DEFAULT 'needs-review' NOT NULL,
	"merge_score" integer,
	"queue_position" integer,
	"atomic" boolean DEFAULT false NOT NULL,
	"cross_package" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"branch" text,
	"subscribed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mega_inline_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"cl_number" integer NOT NULL,
	"file_path" text NOT NULL,
	"side" text DEFAULT 'additions' NOT NULL,
	"line" integer NOT NULL,
	"author_id" text NOT NULL,
	"replies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"title" text NOT NULL,
	"sha" text NOT NULL,
	"published_at" timestamp with time zone,
	"prerelease" boolean DEFAULT false NOT NULL,
	"major" boolean DEFAULT false NOT NULL,
	"author_id" text NOT NULL,
	"commits_since" integer DEFAULT 0 NOT NULL,
	"since_tag" text,
	"status" text DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_agent_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"scope_package_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'public' NOT NULL,
	"name" text NOT NULL,
	"topic" text,
	"participant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mega_channel_members" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_message_id" text,
	"muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mega_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'mention' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"url" text NOT NULL,
	"summary" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mega_doc_collaborators" ADD CONSTRAINT "mega_doc_collaborators_doc_id_mega_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."mega_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_collaborators" ADD CONSTRAINT "mega_doc_collaborators_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_comments" ADD CONSTRAINT "mega_doc_comments_doc_id_mega_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."mega_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_comments" ADD CONSTRAINT "mega_doc_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_stars" ADD CONSTRAINT "mega_doc_stars_doc_id_mega_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."mega_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_stars" ADD CONSTRAINT "mega_doc_stars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_versions" ADD CONSTRAINT "mega_doc_versions_doc_id_mega_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."mega_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_doc_versions" ADD CONSTRAINT "mega_doc_versions_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_docs" ADD CONSTRAINT "mega_docs_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_issue_comments" ADD CONSTRAINT "mega_issue_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_issues" ADD CONSTRAINT "mega_issues_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_cl_comments" ADD CONSTRAINT "mega_cl_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_cls" ADD CONSTRAINT "mega_cls_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_inline_comments" ADD CONSTRAINT "mega_inline_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_releases" ADD CONSTRAINT "mega_releases_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_messages" ADD CONSTRAINT "mega_messages_channel_id_mega_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."mega_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_messages" ADD CONSTRAINT "mega_messages_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_channel_members" ADD CONSTRAINT "mega_channel_members_channel_id_mega_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."mega_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_channel_members" ADD CONSTRAINT "mega_channel_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_channel_members" ADD CONSTRAINT "mega_channel_members_last_read_message_id_mega_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."mega_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mega_notifications" ADD CONSTRAINT "mega_notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mega_doc_collaborators_doc_user_uidx" ON "mega_doc_collaborators" USING btree ("doc_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_doc_stars_user_doc_uidx" ON "mega_doc_stars" USING btree ("user_id","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_doc_versions_doc_version_uidx" ON "mega_doc_versions" USING btree ("doc_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_docs_title_live_uidx" ON "mega_docs" USING btree ("title") WHERE "mega_docs"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mega_content_blocks_source_idx" ON "mega_content_blocks" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "mega_content_blocks_block_id_idx" ON "mega_content_blocks" USING btree ("block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_content_blocks_source_block_uidx" ON "mega_content_blocks" USING btree ("source_type","source_id","block_id");--> statement-breakpoint
CREATE INDEX "mega_content_links_source_idx" ON "mega_content_links" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "mega_content_links_target_idx" ON "mega_content_links" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_issues_number_uidx" ON "mega_issues" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_cls_number_uidx" ON "mega_cls" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_releases_tag_uidx" ON "mega_releases" USING btree ("tag");--> statement-breakpoint
CREATE UNIQUE INDEX "mega_channel_members_channel_user_uidx" ON "mega_channel_members" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "mega_notifications_user_unread_idx" ON "mega_notifications" USING btree ("user_id") WHERE "mega_notifications"."read_at" IS NULL;