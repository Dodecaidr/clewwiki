CREATE TABLE "page_collab_states" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"base_content_hash" text NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_collab_states_size" CHECK (octet_length("page_collab_states"."state") <= 33554432)
);
--> statement-breakpoint
ALTER TABLE "page_collab_states" ADD CONSTRAINT "page_collab_states_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_collab_states" ADD CONSTRAINT "page_collab_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_collab_states_workspace_idx" ON "page_collab_states" USING btree ("workspace_id");