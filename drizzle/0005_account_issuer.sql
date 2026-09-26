-- Better Auth 1.7 scopes account identity by (issuer, account_id).
-- Credential accounts use local:credential; OAuth providers without their
-- own issuer use local:oauth:<providerId> (see createOAuthAccountIssuer).
-- Guarded so incremental tests that never created "account" still apply.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'account'
  ) THEN
    ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;

    UPDATE "account"
    SET issuer = CASE
      WHEN provider_id = 'credential' THEN 'local:credential'
      ELSE 'local:oauth:' || provider_id
    END
    WHERE issuer IS NULL;

    ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_account_id_key"
      ON "account" ("issuer", "account_id");
  END IF;
END $$;
