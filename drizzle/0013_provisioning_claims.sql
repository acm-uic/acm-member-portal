ALTER TABLE provisioning_events ADD COLUMN claim_token uuid;

CREATE INDEX provisioning_events_submission_latest_idx
  ON provisioning_events (submission_id, created_at DESC, id DESC);
