CREATE TABLE "import_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "import_images_size" CHECK (octet_length("import_images"."data") <= 10485760)
);
--> statement-breakpoint
ALTER TABLE "import_images" ADD CONSTRAINT "import_images_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_images_import_key" ON "import_images" USING btree ("import_id","key");