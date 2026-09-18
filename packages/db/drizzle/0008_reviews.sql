CREATE TYPE "public"."review_decision" AS ENUM('accepted', 'reverted');--> statement-breakpoint
CREATE TABLE "page_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"result_version" integer,
	"reviewer_id" text NOT NULL,
	"reviewer_label" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_reviews_version_range" CHECK ("page_reviews"."from_version" >= 0 and "page_reviews"."to_version" > "page_reviews"."from_version"),
	CONSTRAINT "page_reviews_note_length" CHECK ("page_reviews"."note" is null or char_length("page_reviews"."note") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "page_reviews" ADD CONSTRAINT "page_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_reviews" ADD CONSTRAINT "page_reviews_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_reviews" ADD CONSTRAINT "page_reviews_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_reviews_page_idx" ON "page_reviews" USING btree ("page_id","to_version");--> statement-breakpoint
CREATE INDEX "page_reviews_space_created_idx" ON "page_reviews" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "page_revisions_created_idx" ON "page_revisions" USING btree ("created_at","id");