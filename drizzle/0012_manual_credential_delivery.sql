ALTER TABLE provisioning_events
  ADD COLUMN credential_delivery_mode text NOT NULL DEFAULT 'email'
    CHECK (credential_delivery_mode IN ('email', 'admin')),
  ADD COLUMN credential_reveal_token uuid;
