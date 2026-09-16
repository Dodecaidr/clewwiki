CREATE TYPE "public"."anchor_state" AS ENUM('fresh', 'stale', 'moved-renamed', 'lost');--> statement-breakpoint
CREATE TABLE "anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"section_id" text,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"qualified_name" text NOT NULL,
	"container" text,
	"file_hint" text NOT NULL,
	"token_hash" text NOT NULL,
	"body_hash" text,
	"body_token_count" integer DEFAULT 0 NOT NULL,
	"line_start" integer,
	"line_end" integer,
	"fallback" boolean DEFAULT false NOT NULL,
	"state" "anchor_state" DEFAULT 'fresh' NOT NULL,
	"detail" jsonb,
	"last_checked_ref" text,
	"last_checked_at" timestamp with time zone,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anchors" ADD CONSTRAINT "anchors_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anchors_page_idx" ON "anchors" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "anchors_workspace_state_idx" ON "anchors" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "anchors_workspace_file_idx" ON "anchors" USING btree ("workspace_id","file_hint");--> statement-breakpoint
CREATE UNIQUE INDEX "anchors_page_target_key" ON "anchors" USING btree ("page_id","kind","qualified_name","file_hint") WHERE "anchors"."section_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "anchors_section_target_key" ON "anchors" USING btree ("page_id","section_id","kind","qualified_name","file_hint") WHERE "anchors"."section_id" is not null;