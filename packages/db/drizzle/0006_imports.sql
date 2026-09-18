-- Staged documentation imports.
--
-- Generated from `src/schema.ts`; nothing here moves existing data. An import
-- is parsed into `import_items` and stops there: a person reviews the tree, the
-- target paths and the per-item warnings, and only an explicit apply writes
-- anything into `pages`. That is why the rows exist at all — a Confluence space
-- or a PDF is a guess about structure, and a guess must not become somebody's
-- wiki without being read first.
--
-- `imports.params` records what the import was pointed at and never how it got
-- in: a Confluence run stores the site address and the space key, while the
-- e-mail and API token live in memory for one request and are written nowhere.
CREATE TYPE "public"."import_decision" AS ENUM('create', 'skip', 'overwrite');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('confluence', 'notion', 'markdown', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'running', 'needs_review', 'applied', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"target_path" text NOT NULL,
	"parent_source_id" text,
	"markdown" text DEFAULT '' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" "import_decision" DEFAULT 'create' NOT NULL,
	"created_page_id" uuid,
	"ordering" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_created_page_id_pages_id_fk" FOREIGN KEY ("created_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_items_import_source_key" ON "import_items" USING btree ("import_id","source_id");--> statement-breakpoint
CREATE INDEX "import_items_import_ordering_idx" ON "import_items" USING btree ("import_id","ordering");--> statement-breakpoint
CREATE INDEX "imports_space_created_idx" ON "imports" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "imports_workspace_status_idx" ON "imports" USING btree ("workspace_id","status");