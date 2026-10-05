CREATE TYPE "public"."dev_release_state" AS ENUM('planned', 'shipped');--> statement-breakpoint
CREATE TYPE "public"."dev_stream_state" AS ENUM('planned', 'active', 'review', 'merged', 'paused', 'dropped');--> statement-breakpoint
CREATE TABLE "dev_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" "dev_release_state" DEFAULT 'planned' NOT NULL,
	"due_on" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shipped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dev_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text NOT NULL,
	"ref" text,
	"state" "dev_stream_state" DEFAULT 'active' NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"issue_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"release_id" uuid,
	"docs_page_id" uuid,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	"branch" jsonb
);
--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "stream_id" uuid;--> statement-breakpoint
ALTER TABLE "dev_releases" ADD CONSTRAINT "dev_releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_releases" ADD CONSTRAINT "dev_releases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_streams" ADD CONSTRAINT "dev_streams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_streams" ADD CONSTRAINT "dev_streams_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_streams" ADD CONSTRAINT "dev_streams_release_id_dev_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."dev_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_streams" ADD CONSTRAINT "dev_streams_docs_page_id_pages_id_fk" FOREIGN KEY ("docs_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dev_releases_space_name_key" ON "dev_releases" USING btree ("space_id",lower("name"));--> statement-breakpoint
CREATE INDEX "dev_streams_space_idx" ON "dev_streams" USING btree ("space_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dev_streams_space_ref_key" ON "dev_streams" USING btree ("space_id","ref") WHERE "dev_streams"."ref" is not null;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_stream_id_dev_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."dev_streams"("id") ON DELETE set null ON UPDATE no action;