CREATE TYPE "public"."presence_mode" AS ENUM('viewing', 'editing');--> statement-breakpoint
CREATE TABLE "presence_heartbeats" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"page_id" uuid,
	"mode" "presence_mode" DEFAULT 'viewing' NOT NULL,
	"automated" boolean DEFAULT false NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_heartbeats_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presence_heartbeats_seen_idx" ON "presence_heartbeats" USING btree ("workspace_id","seen_at");