CREATE TABLE "page_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"page_id" uuid,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_images_size" CHECK (octet_length("page_images"."data") <= 10485760),
	CONSTRAINT "page_images_type" CHECK ("page_images"."content_type" in ('image/png', 'image/jpeg', 'image/gif', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "page_images" ADD CONSTRAINT "page_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_images" ADD CONSTRAINT "page_images_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_images" ADD CONSTRAINT "page_images_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_images_page_idx" ON "page_images" USING btree ("page_id","sha256");--> statement-breakpoint
CREATE INDEX "page_images_workspace_created_idx" ON "page_images" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "page_images_unattached_idx" ON "page_images" USING btree ("created_at") WHERE "page_images"."page_id" is null;