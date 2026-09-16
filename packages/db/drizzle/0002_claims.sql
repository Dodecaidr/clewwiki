CREATE TYPE "public"."claim_release_reason" AS ENUM('released', 'expired', 'forced');--> statement-breakpoint
CREATE TABLE "claim_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_id" text NOT NULL,
	"author_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "claim_notes_text_length" CHECK (char_length("claim_notes"."text") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"section_id" text,
	"holder_type" "actor_type" NOT NULL,
	"holder_id" text NOT NULL,
	"holder_label" text NOT NULL,
	"base_content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	"release_reason" "claim_release_reason"
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_notes" ADD CONSTRAINT "claim_notes_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_notes" ADD CONSTRAINT "claim_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_notes_claim_idx" ON "claim_notes" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claim_notes_workspace_expires_idx" ON "claim_notes" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_active_page_key" ON "claims" USING btree ("page_id") WHERE "claims"."released_at" is null and "claims"."section_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "claims_active_section_key" ON "claims" USING btree ("page_id","section_id") WHERE "claims"."released_at" is null and "claims"."section_id" is not null;--> statement-breakpoint
CREATE INDEX "claims_workspace_active_idx" ON "claims" USING btree ("workspace_id","expires_at") WHERE "claims"."released_at" is null;--> statement-breakpoint
CREATE INDEX "claims_holder_idx" ON "claims" USING btree ("holder_type","holder_id");