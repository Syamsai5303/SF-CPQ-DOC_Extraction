-- Step 2: multi-org connections, CPQ catalog extractions, AI assessment reports.
-- Hand-written so existing single-org credentials are preserved: each user's saved
-- credential becomes their first SalesforceConnection and their active org.
-- (Ciphertexts stay valid: they are bound to user_id, which does not change.)

-- CreateEnum
CREATE TYPE "EnvironmentType" AS ENUM ('PRODUCTION', 'SANDBOX', 'UAT', 'DEVELOPER', 'OTHER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- ---------- salesforce_credentials (1:1) -> salesforce_connections (1:N) ----------
ALTER TABLE "salesforce_credentials" RENAME TO "salesforce_connections";
ALTER TABLE "salesforce_connections" RENAME CONSTRAINT "salesforce_credentials_pkey" TO "salesforce_connections_pkey";
ALTER TABLE "salesforce_connections" RENAME CONSTRAINT "salesforce_credentials_user_id_fkey" TO "salesforce_connections_user_id_fkey";
DROP INDEX "salesforce_credentials_user_id_key";

ALTER TABLE "salesforce_connections" RENAME COLUMN "encrypted_secrets" TO "encrypted_credentials";
ALTER TABLE "salesforce_connections" RENAME COLUMN "last_verified_at" TO "last_verified";

ALTER TABLE "salesforce_connections"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "environment_type" "EnvironmentType" NOT NULL DEFAULT 'OTHER';

-- Infer a label for existing rows from the login / token URL.
UPDATE "salesforce_connections"
SET "environment_type" = CASE
      WHEN COALESCE("login_url", "token_url", "instance_url", '') ~* '(test\.salesforce\.com|\.sandbox\.|--)' THEN 'SANDBOX'::"EnvironmentType"
      ELSE 'PRODUCTION'::"EnvironmentType"
    END;
UPDATE "salesforce_connections"
SET "name" = CASE "environment_type" WHEN 'SANDBOX' THEN 'Sandbox' ELSE 'Production' END;

ALTER TABLE "salesforce_connections" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "salesforce_connections" ALTER COLUMN "environment_type" DROP DEFAULT;

CREATE INDEX "salesforce_connections_user_id_idx" ON "salesforce_connections"("user_id");
CREATE UNIQUE INDEX "salesforce_connections_user_id_name_key" ON "salesforce_connections"("user_id", "name");

-- ---------- users: active org + custom document logo ----------
ALTER TABLE "users" ADD COLUMN "active_connection_id" TEXT,
ADD COLUMN "logo_image" BYTEA,
ADD COLUMN "logo_mime" TEXT,
ADD COLUMN "logo_updated_at" TIMESTAMP(3);

UPDATE "users" u SET "active_connection_id" = c."id"
FROM "salesforce_connections" c WHERE c."user_id" = u."id";

ALTER TABLE "users" ADD CONSTRAINT "users_active_connection_id_fkey" FOREIGN KEY ("active_connection_id") REFERENCES "salesforce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- catalog_extractions ----------
CREATE TABLE "catalog_extractions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" JSONB,
    "summary" JSONB,
    "catalog_gz" BYTEA,
    "catalog_bytes" INTEGER,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_extractions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_extractions_connection_id_created_at_idx" ON "catalog_extractions"("connection_id", "created_at");
CREATE INDEX "catalog_extractions_user_id_idx" ON "catalog_extractions"("user_id");
ALTER TABLE "catalog_extractions" ADD CONSTRAINT "catalog_extractions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_extractions" ADD CONSTRAINT "catalog_extractions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "salesforce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- assessment_reports ----------
CREATE TABLE "assessment_reports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "extraction_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "model" TEXT NOT NULL,
    "markdown" TEXT,
    "progress" JSONB,
    "prompt_tokens" INTEGER,
    "output_tokens" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "assessment_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assessment_reports_extraction_id_created_at_idx" ON "assessment_reports"("extraction_id", "created_at");
CREATE INDEX "assessment_reports_user_id_idx" ON "assessment_reports"("user_id");
ALTER TABLE "assessment_reports" ADD CONSTRAINT "assessment_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assessment_reports" ADD CONSTRAINT "assessment_reports_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "catalog_extractions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
