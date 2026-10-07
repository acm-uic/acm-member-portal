-- Store delivery progress, never the temporary password itself.
ALTER TABLE "provisioning_events"
  ADD COLUMN IF NOT EXISTS "credential_delivery_status" text;

-- Older interrupted/failed events have no delivery receipt. Do not assume that
-- an existing account means their credentials were emailed successfully.
UPDATE "provisioning_events"
SET "credential_delivery_status" = 'pending'
WHERE "credential_delivery_status" IS NULL
  AND "status" IN ('processing', 'failed', 'dead_lettered');
