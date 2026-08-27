-- Username as a first-class identity field (signup + user).
-- Also copy UIN from approved signups onto user rows that never received it.

ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "username" text;

UPDATE "signup_submissions"
SET username = netid
WHERE username IS NULL;

ALTER TABLE "signup_submissions" ALTER COLUMN "username" SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) THEN
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "username" text;
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "first_name" text;
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "last_name" text;
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "preferred_name" text;

    UPDATE "user"
    SET username = netid
    WHERE username IS NULL AND netid IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS "user_username_key"
      ON "user" ("username")
      WHERE "username" IS NOT NULL;

    UPDATE "user" AS u
    SET uin = s.uin
    FROM "signup_submissions" AS s
    WHERE u.uin IS NULL
      AND s.uin IS NOT NULL
      AND s.status = 'approved'
      AND u.netid IS NOT NULL
      AND s.netid = u.netid;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_events'
  ) THEN
    CREATE INDEX IF NOT EXISTS "audit_events_target_idx"
      ON "audit_events" ("target_type", "target_id");
  END IF;
END $$;
