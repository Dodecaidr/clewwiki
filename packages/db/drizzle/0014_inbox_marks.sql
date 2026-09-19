CREATE TABLE "inbox_marks" (
	"workspace_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_marks_workspace_id_actor_type_actor_id_pk" PRIMARY KEY("workspace_id","actor_type","actor_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_marks" ADD CONSTRAINT "inbox_marks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;