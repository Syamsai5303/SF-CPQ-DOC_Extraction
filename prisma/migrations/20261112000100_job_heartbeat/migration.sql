-- Worker heartbeat so stale jobs can be recovered safely when several app instances run.
ALTER TABLE "catalog_extractions" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "assessment_reports" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
