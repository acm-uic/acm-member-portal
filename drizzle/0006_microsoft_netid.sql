-- Microsoft profiles previously stored the full UPN in user.netid.
-- Keep account identity and email intact. Leave ambiguous NetIDs for review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'account'
  ) THEN
    WITH candidates AS (
      SELECT u.id, btrim(split_part(u.netid, '@', 1)) AS netid
      FROM "user" AS u
      WHERE u.netid LIKE '%@%'
        AND (
          u.entra_oid IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM "account" AS a
            WHERE a.user_id = u.id AND a.provider_id = 'microsoft'
          )
        )
    )
    UPDATE "user" AS u
    SET netid = c.netid, updated_at = now()
    FROM candidates AS c
    WHERE u.id = c.id
      AND c.netid <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "user" AS other
        WHERE other.id <> c.id AND other.netid = c.netid
      )
      AND NOT EXISTS (
        SELECT 1 FROM candidates AS other
        WHERE other.id <> c.id AND other.netid = c.netid
      );
  END IF;
END $$;
