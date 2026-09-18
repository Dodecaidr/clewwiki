-- Discussions, and the decisions they leave behind.
--
-- Generated from `src/schema.ts`; nothing here moves existing data. Two tables
-- and one enum. `discussions.expires_at` is the single deadline the sweep
-- reads — when an open thread will be closed for inactivity, and once resolved,
-- when it will be deleted — which is why it is `not null` and indexed with the
-- workspace.
--
-- `decision_page_id` references `pages` and not the other way round on purpose:
-- deleting a discussion takes its messages with it and leaves the decision page
-- standing, because the page is what the whole arrangement exists to keep.
--
-- The retention knobs themselves are not columns. They live in
-- `spaces.settings` (`discussion_idle_days`, `discussion_retention_days`,
-- `decisions_page_id`), read with the space row and queried by nothing.
CREATE TYPE "public"."discussion_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "discussion_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_id" text NOT NULL,
	"author_label" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discussion_messages_body_size" CHECK (octet_length("discussion_messages"."body") between 1 and 8192)
);
--> statement-breakpoint
CREATE TABLE "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "discussion_status" DEFAULT 'open' NOT NULL,
	"opened_by_type" "actor_type" NOT NULL,
	"opened_by_id" text NOT NULL,
	"opened_by_label" text NOT NULL,
	"page_id" uuid,
	"section_id" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"decision_page_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discussions_title_length" CHECK (char_length("discussions"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_decision_page_id_pages_id_fk" FOREIGN KEY ("decision_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discussion_messages_discussion_idx" ON "discussion_messages" USING btree ("discussion_id","created_at");--> statement-breakpoint
CREATE INDEX "discussion_messages_workspace_idx" ON "discussion_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "discussions_space_status_idx" ON "discussions" USING btree ("space_id","status","last_activity_at");--> statement-breakpoint
CREATE INDEX "discussions_space_activity_idx" ON "discussions" USING btree ("space_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "discussions_workspace_expires_idx" ON "discussions" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "discussions_page_idx" ON "discussions" USING btree ("page_id");