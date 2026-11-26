CREATE TABLE "mega_cl_links" (
	"link" text PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mega_cl_links_number_uidx" ON "mega_cl_links" USING btree ("number");--> statement-breakpoint
CREATE INDEX "mega_cls_link_idx" ON "mega_cls" USING btree ("link");