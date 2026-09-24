CREATE TABLE "file_blobs" (
	"workspace_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_blobs_workspace_id_sha256_pk" PRIMARY KEY("workspace_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "import_file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"note" text,
	"source_version" integer,
	"source_author" text,
	"source_created_at" timestamp with time zone,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"note" text,
	"restored_from" integer,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_file_versions_version" CHECK ("page_file_versions"."version" >= 1),
	CONSTRAINT "page_file_versions_note_length" CHECK (char_length("page_file_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "page_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_files_name_length" CHECK (char_length("page_files"."name") between 1 and 200),
	CONSTRAINT "page_files_latest_version" CHECK ("page_files"."latest_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"space_id" uuid,
	"page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_one_target" CHECK (("watches"."space_id" is not null) <> ("watches"."page_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "file_blobs" ADD CONSTRAINT "file_blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_versions" ADD CONSTRAINT "import_file_versions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_versions" ADD CONSTRAINT "import_file_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_file_versions" ADD CONSTRAINT "page_file_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_file_versions" ADD CONSTRAINT "page_file_versions_file_id_page_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."page_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_files" ADD CONSTRAINT "page_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_files" ADD CONSTRAINT "page_files_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_blobs_touched_idx" ON "file_blobs" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "import_file_versions_import_idx" ON "import_file_versions" USING btree ("import_id","source_id","position");--> statement-breakpoint
CREATE INDEX "import_file_versions_blob_idx" ON "import_file_versions" USING btree ("workspace_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "page_file_versions_file_version_key" ON "page_file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE INDEX "page_file_versions_workspace_created_idx" ON "page_file_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "page_file_versions_blob_idx" ON "page_file_versions" USING btree ("workspace_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "page_files_page_name_key" ON "page_files" USING btree ("page_id",lower("name"));--> statement-breakpoint
CREATE INDEX "page_files_workspace_idx" ON "page_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watches_actor_space_key" ON "watches" USING btree ("actor_type","actor_id","space_id") WHERE "watches"."space_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "watches_actor_page_key" ON "watches" USING btree ("actor_type","actor_id","page_id") WHERE "watches"."page_id" is not null;--> statement-breakpoint
CREATE INDEX "watches_actor_idx" ON "watches" USING btree ("workspace_id","actor_type","actor_id");