-- Enforce username claims across concurrent signup creation and edits.
-- NetIDs may be shared by accounts with distinct usernames.
CREATE UNIQUE INDEX IF NOT EXISTS "signup_submissions_pending_username_key"
  ON "signup_submissions" ("username")
  WHERE "status" = 'pending';
