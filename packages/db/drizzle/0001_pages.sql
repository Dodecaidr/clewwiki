CREATE TYPE "public"."page_kind" AS ENUM('technical', 'human');--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"summary" text,
	"content_hash" text NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"kind" "page_kind" DEFAULT 'technical' NOT NULL,
	"linked_page_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"summary" text,
	"content_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("summary", '')), 'B') || setweight(to_tsvector('english', coalesce("body", '')), 'C')) STORED,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_type" "actor_type" NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_linked_page_id_pages_id_fk" FOREIGN KEY ("linked_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_revisions_page_version_key" ON "page_revisions" USING btree ("page_id","version");--> statement-breakpoint
CREATE INDEX "page_revisions_page_created_idx" ON "page_revisions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_workspace_path_key" ON "pages" USING btree ("workspace_id","path") WHERE "pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "pages_workspace_parent_idx" ON "pages" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "pages_workspace_path_idx" ON "pages" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "pages_search_idx" ON "pages" USING gin ("search_vector");