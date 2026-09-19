CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid,
	"comment_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentions_one_source" CHECK (("mentions"."message_id" is not null) <> ("mentions"."comment_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_message_id_discussion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."discussion_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_comment_id_page_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."page_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentions_actor_idx" ON "mentions" USING btree ("workspace_id","actor_type","actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_message_actor_key" ON "mentions" USING btree ("message_id","actor_type","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_comment_actor_key" ON "mentions" USING btree ("comment_id","actor_type","actor_id");