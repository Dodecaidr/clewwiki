-- Spaces: one area of the wiki per project or product.
--
-- The schema part of this file is what drizzle-kit generated from
-- `src/schema.ts`. The data part is written by hand and runs in the same
-- transaction, in this order:
--
--   1. every workspace that has pages or a repository setting gets a space
--      with the key MAIN, named after the workspace, carrying a copy of the
--      workspace's repository setting;
--   2. every page — live or soft-deleted — is assigned to that space, so
--      revisions, claims, notes and anchors (which hang on page ids) stay
--      valid untouched;
--   3. path uniqueness moves from (workspace, path) to (space, path);
--   4. the repository setting is removed from the workspace, because the code
--      reads it from the space only from here on;
--   5. agent tokens get `space_ids`, left null, which means "every space": a
--      token issued before this migration reaches exactly what it reached
--      before.
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"home_page_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "spaces_key_format" CHECK ("spaces"."key" ~ '^[A-Z0-9]{2,10}$'),
	CONSTRAINT "spaces_name_length" CHECK (char_length("spaces"."name") between 1 and 100),
	CONSTRAINT "spaces_description_length" CHECK (char_length("spaces"."description") <= 2000),
	CONSTRAINT "spaces_icon_length" CHECK ("spaces"."icon" is null or char_length("spaces"."icon") <= 16)
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_home_page_id_pages_id_fk" FOREIGN KEY ("home_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_workspace_key_key" ON "spaces" USING btree ("workspace_id","key");--> statement-breakpoint
INSERT INTO "spaces" ("workspace_id", "key", "name", "settings")
SELECT
	w."id",
	'MAIN',
	coalesce(nullif(left(btrim(w."name"), 100), ''), 'Main'),
	CASE
		WHEN w."settings" ? 'repository' THEN jsonb_build_object('repository', w."settings" -> 'repository')
		ELSE '{}'::jsonb
	END
FROM "workspaces" w
WHERE w."settings" ? 'repository'
	OR EXISTS (SELECT 1 FROM "pages" p WHERE p."workspace_id" = w."id");--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "space_id" uuid;--> statement-breakpoint
UPDATE "pages" p
SET "space_id" = s."id"
FROM "spaces" s
WHERE s."workspace_id" = p."workspace_id" AND s."key" = 'MAIN';--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "pages_workspace_path_key";--> statement-breakpoint
DROP INDEX "pages_workspace_parent_idx";--> statement-breakpoint
DROP INDEX "pages_workspace_path_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "pages_space_path_key" ON "pages" USING btree ("space_id","path") WHERE "pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "pages_space_parent_idx" ON "pages" USING btree ("space_id","parent_id");--> statement-breakpoint
CREATE INDEX "pages_space_path_idx" ON "pages" USING btree ("space_id","path");--> statement-breakpoint
CREATE INDEX "pages_workspace_updated_idx" ON "pages" USING btree ("workspace_id","updated_at");--> statement-breakpoint
UPDATE "workspaces" SET "settings" = "settings" - 'repository' WHERE "settings" ? 'repository';--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "space_ids" jsonb;
