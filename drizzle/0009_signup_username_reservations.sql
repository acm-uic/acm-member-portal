-- Approval must retain the username claim before the member's first login.
-- Denied submissions release their usernames for a new application.
CREATE UNIQUE INDEX IF NOT EXISTS "signup_submissions_active_username_key"
  ON "signup_submissions" ("username")
  WHERE "status" IN ('pending', 'approved');

DROP INDEX IF EXISTS "signup_submissions_pending_username_key";
