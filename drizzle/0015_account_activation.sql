CREATE TABLE account_activations (
  event_id uuid PRIMARY KEY REFERENCES provisioning_events(id) ON DELETE CASCADE,
  activated_at timestamptz NOT NULL DEFAULT now()
);

-- Atomic shared counters, never passwords. Short-lived rows are pruned on use.
CREATE TABLE account_activation_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  window_start timestamptz NOT NULL
);
CREATE INDEX account_activation_limits_window_idx ON account_activation_limits(window_start);
