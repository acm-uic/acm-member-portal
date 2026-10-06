-- Support multiple ACM accounts for one university NetID. Keep usernames unique.
DROP INDEX IF EXISTS "signup_submissions_pending_netid_key";
CREATE INDEX IF NOT EXISTS "signup_submissions_netid_idx"
  ON "signup_submissions" ("netid");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) THEN
    ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_netid_key";
    ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_netid_unique";
    DROP INDEX IF EXISTS "user_netid_key";
    DROP INDEX IF EXISTS "user_netid_unique";
    CREATE INDEX IF NOT EXISTS "user_netid_idx" ON "user" ("netid");
  END IF;
END $$;
