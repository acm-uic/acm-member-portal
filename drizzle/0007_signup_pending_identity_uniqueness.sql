-- Enforce identity claims across signup creation and edits, including concurrent
-- transactions. Reviewed submissions may reuse identities. Existing pending
-- duplicates must be resolved before this migration can succeed.
CREATE UNIQUE INDEX IF NOT EXISTS "signup_submissions_pending_netid_key"
  ON "signup_submissions" ("netid")
  WHERE "status" = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS "signup_submissions_pending_username_key"
  ON "signup_submissions" ("username")
  WHERE "status" = 'pending';
