CREATE TABLE provisioning_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES provisioning_events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'queued', 'started', 'credentials_pending', 'credentials_delivered',
    'credentials_ready', 'provisioned', 'failed', 'dead_lettered', 'retry_requested'
  )),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  message text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provisioning_logs_event_time_idx
  ON provisioning_logs (event_id, created_at DESC, id DESC);

CREATE INDEX provisioning_events_updated_idx
  ON provisioning_events (updated_at DESC, id DESC);
