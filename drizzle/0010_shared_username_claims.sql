-- One claim serializes signup and member username writes across both tables.
CREATE TABLE "username_claims" (
  "username" text PRIMARY KEY,
  "signup_submission_id" uuid UNIQUE REFERENCES "signup_submissions" ("id") ON DELETE SET NULL,
  "user_id" text UNIQUE REFERENCES "user" ("id") ON DELETE SET NULL
);

INSERT INTO username_claims (username, signup_submission_id)
  SELECT username, id FROM signup_submissions WHERE status IN ('pending', 'approved');

-- An existing account may share its approved signup's claim, but not a pending one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "user" u JOIN signup_submissions s USING (username)
    WHERE s.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A member username conflicts with a pending signup'
      USING ERRCODE = '23505', CONSTRAINT = 'username_claims_username_key';
  END IF;
END $$;

INSERT INTO username_claims (username, user_id)
  SELECT username, id FROM "user" WHERE username IS NOT NULL
  ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id;

CREATE FUNCTION maintain_signup_username_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.username = NEW.username
        AND (OLD.status IN ('pending', 'approved')) = (NEW.status IN ('pending', 'approved')) THEN
        RETURN NEW;
      END IF;
    END IF;
    UPDATE username_claims SET signup_submission_id = NULL
      WHERE username = OLD.username AND signup_submission_id = OLD.id;
    DELETE FROM username_claims WHERE username = OLD.username
      AND signup_submission_id IS NULL AND user_id IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.status IN ('pending', 'approved') THEN
    INSERT INTO username_claims AS claims (username, signup_submission_id)
      VALUES (NEW.username, NEW.id)
      ON CONFLICT (username) DO UPDATE SET signup_submission_id = EXCLUDED.signup_submission_id
      WHERE claims.user_id IS NULL
        AND (claims.signup_submission_id IS NULL OR claims.signup_submission_id = NEW.id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Username is already claimed'
        USING ERRCODE = '23505', CONSTRAINT = 'username_claims_username_key';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signup_username_claim
  AFTER INSERT OR UPDATE OF username, status OR DELETE ON signup_submissions
  FOR EACH ROW EXECUTE FUNCTION maintain_signup_username_claim();

CREATE FUNCTION maintain_user_username_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.username IS NOT DISTINCT FROM NEW.username THEN RETURN NEW; END IF;
    END IF;
    UPDATE username_claims SET user_id = NULL
      WHERE username = OLD.username AND user_id = OLD.id;
    DELETE FROM username_claims WHERE username = OLD.username
      AND signup_submission_id IS NULL AND user_id IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.username IS NOT NULL THEN
    INSERT INTO username_claims AS claims (username, user_id)
      VALUES (NEW.username, NEW.id)
      ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id
      WHERE (claims.user_id IS NULL OR claims.user_id = NEW.id)
        AND (
          claims.signup_submission_id IS NULL OR claims.user_id = NEW.id OR
          (TG_OP = 'INSERT' AND EXISTS (
            SELECT 1 FROM signup_submissions
            WHERE id = claims.signup_submission_id AND status = 'approved'
          ))
        );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Username is already claimed'
        USING ERRCODE = '23505', CONSTRAINT = 'username_claims_username_key';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_username_claim
  AFTER INSERT OR UPDATE OF username OR DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION maintain_user_username_claim();
