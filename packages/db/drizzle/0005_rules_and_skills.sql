-- Rules of a space, and its skills registry.
--
-- Generated from `src/schema.ts`; nothing here moves existing data. The rules
-- of a project are an ordinary page, so the space only gains a pointer at one
-- (`rules_page_id`, null until somebody designates a page). Skills get a table
-- of their own: a skill has no path, no parent and no counterpart, and it is
-- addressed by a slug that has to be safe as a directory name on the machine
-- that installs it.
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_type" "actor_type" NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "skills_slug_format" CHECK ("skills"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "skills_slug_length" CHECK (char_length("skills"."slug") <= 80),
	CONSTRAINT "skills_name_length" CHECK (char_length("skills"."name") between 1 and 100),
	CONSTRAINT "skills_description_length" CHECK (char_length("skills"."description") between 1 and 1024),
	CONSTRAINT "skills_version_length" CHECK ("skills"."version" is null or char_length("skills"."version") <= 40),
	CONSTRAINT "skills_body_size" CHECK (octet_length("skills"."body") <= 262144)
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "rules_page_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_space_slug_key" ON "skills" USING btree ("space_id","slug") WHERE "skills"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "skills_space_updated_idx" ON "skills" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE INDEX "skills_workspace_idx" ON "skills" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_rules_page_id_pages_id_fk" FOREIGN KEY ("rules_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;