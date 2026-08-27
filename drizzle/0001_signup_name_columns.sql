-- Expand-only: signup_submissions.display_name -> first_name / last_name / preferred_name.
-- 0000_initial.sql was edited in place after some environments had already applied it.

ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "first_name" text;
ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "last_name" text;
ALTER TABLE "signup_submissions" ADD COLUMN IF NOT EXISTS "preferred_name" text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'signup_submissions'
      AND column_name = 'display_name'
  ) THEN
    UPDATE "signup_submissions"
    SET
      first_name = COALESCE(
        NULLIF(btrim(first_name), ''),
        NULLIF(split_part(btrim(display_name), ' ', 1), ''),
        'Unknown'
      ),
      last_name = COALESCE(
        NULLIF(btrim(last_name), ''),
        NULLIF(
          btrim(substring(
            btrim(display_name)
            FROM length(split_part(btrim(display_name), ' ', 1)) + 2
          )),
          ''
        ),
        ''
      );

    ALTER TABLE "signup_submissions" DROP COLUMN "display_name";
  END IF;
END $$;

UPDATE "signup_submissions" SET "first_name" = 'Unknown' WHERE "first_name" IS NULL;
UPDATE "signup_submissions" SET "last_name" = '' WHERE "last_name" IS NULL;

ALTER TABLE "signup_submissions" ALTER COLUMN "first_name" SET NOT NULL;
ALTER TABLE "signup_submissions" ALTER COLUMN "last_name" SET NOT NULL;
