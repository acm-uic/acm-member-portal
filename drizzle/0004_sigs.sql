-- SIG catalog and SIG leader assignments.
-- Keys match signup form `sig_interest` option values.

CREATE TABLE IF NOT EXISTS "sigs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

INSERT INTO "sigs" ("id", "key", "display_name", "active") VALUES
  ('00000000-0000-0000-0000-000000000101', 'sig-ai', 'SIG AI', true),
  ('00000000-0000-0000-0000-000000000102', 'sig-algotrading', 'SIG Algorithmic Trading', true),
  ('00000000-0000-0000-0000-000000000103', 'sig-cybersecurity', 'SIG Cybersecurity', true),
  ('00000000-0000-0000-0000-000000000104', 'sig-game', 'SIG Game', true),
  ('00000000-0000-0000-0000-000000000105', 'sig-hacks', 'SIG Hacks', true),
  ('00000000-0000-0000-0000-000000000106', 'sig-indiedev', 'SIG Indie Dev', true),
  ('00000000-0000-0000-0000-000000000107', 'sig-jobs', 'SIG Jobs', true),
  ('00000000-0000-0000-0000-000000000108', 'sig-math', 'SIG Math', true),
  ('00000000-0000-0000-0000-000000000109', 'sig-mobiledev', 'SIG Mobile Development', true),
  ('00000000-0000-0000-0000-000000000110', 'sig-pcbuild', 'SIG PC Build', true),
  ('00000000-0000-0000-0000-000000000111', 'sig-sysadmin', 'SIG SysAdmin', true),
  ('00000000-0000-0000-0000-000000000112', 'sig-systems', 'SIG Systems', true),
  ('00000000-0000-0000-0000-000000000113', 'sig-virtualreality', 'SIG Virtual Reality', true),
  ('00000000-0000-0000-0000-000000000114', 'sig-webdev', 'SIG WebDev', true)
ON CONFLICT ("key") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) THEN
    CREATE TABLE IF NOT EXISTS "sig_leaders" (
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "sig_id" uuid NOT NULL REFERENCES "sigs"("id") ON DELETE CASCADE,
      "assigned_by" text REFERENCES "user"("id"),
      "assigned_at" timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY ("user_id", "sig_id")
    );

    CREATE INDEX IF NOT EXISTS "sig_leaders_sig_id_idx"
      ON "sig_leaders" ("sig_id");
  END IF;
END $$;
