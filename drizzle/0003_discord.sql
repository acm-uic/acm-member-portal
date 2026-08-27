-- Discord snowflake as a linked identity (signup + user + account).
-- Unique among members and among pending signups; denied/approved rows may reuse.

ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "discord_id" text;
ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "discord_username" text;
ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "discord_in_guild" boolean;

CREATE UNIQUE INDEX IF NOT EXISTS "signup_submissions_pending_discord_id_key"
  ON "signup_submissions" ("discord_id")
  WHERE "status" = 'pending' AND "discord_id" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) THEN
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "discord_id" text;
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "discord_username" text;

    CREATE UNIQUE INDEX IF NOT EXISTS "user_discord_id_key"
      ON "user" ("discord_id")
      WHERE "discord_id" IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'account'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_id_key"
      ON "account" ("provider_id", "account_id");
  END IF;
END $$;
