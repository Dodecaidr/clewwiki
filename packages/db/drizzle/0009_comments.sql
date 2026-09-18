CREATE TABLE "page_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_id" uuid,
	"version" integer,
	"block_fingerprint" text,
	"block_index" integer,
	"quote" text,
	"author_type" "actor_type" NOT NULL,
	"author_id" text NOT NULL,
	"author_label" text NOT NULL,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_type" "actor_type",
	"resolved_by_id" text,
	"resolved_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_comments_body_size" CHECK (octet_length("page_comments"."body") between 1 and 8192),
	CONSTRAINT "page_comments_anchor_shape" CHECK (("page_comments"."block_fingerprint" is null and "page_comments"."block_index" is null and "page_comments"."quote" is null)
        or ("page_comments"."parent_id" is null and "page_comments"."block_fingerprint" is not null and "page_comments"."block_index" is not null and "page_comments"."block_index" >= 0 and "page_comments"."quote" is not null and "page_comments"."version" is not null)),
	CONSTRAINT "page_comments_reply_shape" CHECK ("page_comments"."parent_id" is null or ("page_comments"."resolved_at" is null and "page_comments"."version" is null))
);
--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_parent_id_page_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."page_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_comments_page_idx" ON "page_comments" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "page_comments_parent_idx" ON "page_comments" USING btree ("parent_id","created_at");--> statement-breakpoint
CREATE INDEX "page_comments_space_open_idx" ON "page_comments" USING btree ("space_id","created_at") WHERE "page_comments"."parent_id" is null and "page_comments"."resolved_at" is null;