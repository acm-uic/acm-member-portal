-- Initial schema: better-auth core tables + ACM portal domain tables.
-- Hand-authored to match src/lib/db/schema.ts, with idempotent seed data
-- appended (ON CONFLICT DO NOTHING — safe to re-apply).

CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "netid" text UNIQUE,
  "uin" text,
  "display_name" text,
  "entra_oid" text
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "token" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "id_token" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "form_schemas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "form_key" text NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  "season" text,
  "fields" jsonb NOT NULL,
  "created_by" text REFERENCES "user"("id"),
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "form_schemas_form_key_version_key" UNIQUE ("form_key", "version")
);

CREATE TABLE IF NOT EXISTS "member_profiles" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE cascade,
  "answers" jsonb NOT NULL DEFAULT '{}',
  "answers_schema_version_id" uuid REFERENCES "form_schemas"("id"),
  "ad_provisioning_status" text NOT NULL DEFAULT 'pending' CHECK (ad_provisioning_status IN ('pending','provisioned','failed')),
  "provisioned_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  "deactivated_at" timestamptz,
  "deactivated_by" text REFERENCES "user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "member_profiles_grad_year_idx" ON "member_profiles" ((answers->>'grad_year'));
CREATE INDEX IF NOT EXISTS "member_profiles_status_idx" ON "member_profiles" ("status");

CREATE TABLE IF NOT EXISTS "signup_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schema_version_id" uuid NOT NULL REFERENCES "form_schemas"("id"),
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "preferred_name" text,
  "netid" text NOT NULL,
  "uin" text,
  "email" text NOT NULL,
  "answers" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  "reviewed_by" text REFERENCES "user"("id"),
  "reviewed_at" timestamptz,
  "denial_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "signup_submissions_status_idx" ON "signup_submissions" ("status");

CREATE TABLE IF NOT EXISTS "permissions" (
  "key" text PRIMARY KEY,
  "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "is_system" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE cascade,
  "permission_key" text NOT NULL REFERENCES "permissions"("key") ON DELETE cascade,
  PRIMARY KEY ("role_id", "permission_key")
);

CREATE TABLE IF NOT EXISTS "user_roles" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE cascade,
  "assigned_by" text REFERENCES "user"("id"),
  "assigned_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "role_id")
);

CREATE TABLE IF NOT EXISTS "content_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" text NOT NULL CHECK (type IN ('announcement','document','meeting_note')),
  "title" text NOT NULL,
  "body" text,
  "status" text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  "author_id" text REFERENCES "user"("id"),
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "content_items_type_status_idx" ON "content_items" ("type", "status");

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" bigserial PRIMARY KEY,
  "actor_id" text REFERENCES "user"("id"),
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "provisioning_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id" uuid NOT NULL REFERENCES "signup_submissions"("id"),
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','provisioned','failed','dead_lettered')),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "provisioning_events_claim_idx" ON "provisioning_events" ("status", "next_attempt_at");

-- ============ Seeds (idempotent) ============

INSERT INTO "permissions" ("key", "description") VALUES
  ('admin.access', 'Access the admin panel'),
  ('signups.review', 'View pending signup submissions'),
  ('signups.approve', 'Approve or deny signup submissions'),
  ('provisioning.retry', 'Retry dead-lettered provisioning events'),
  ('members.read', 'View member directory'),
  ('members.read.restricted', 'View UIN and demographic answers'),
  ('members.manage', 'Edit member accounts and role assignments'),
  ('members.deactivate', 'Deactivate member accounts'),
  ('roles.read', 'View roles and permissions'),
  ('roles.manage', 'Edit role permission grants'),
  ('forms.read', 'View signup form schemas'),
  ('forms.manage', 'Create and publish signup form schemas'),
  ('content.read', 'Read published content'),
  ('content.publish', 'Publish hosted content'),
  ('content.manage', 'Edit and archive any hosted content'),
  ('alumni.review', 'View alumni transition suggestions'),
  ('alumni.approve', 'Approve alumni transitions')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "roles" ("id", "key", "display_name", "is_system") VALUES
  ('00000000-0000-0000-0000-000000000001', 'member', 'Member', true),
  ('00000000-0000-0000-0000-000000000002', 'officer', 'Officer', true),
  ('00000000-0000-0000-0000-000000000003', 'admin', 'Admin', true),
  ('00000000-0000-0000-0000-000000000004', 'sig_leader', 'Sig Leader', true),
  ('00000000-0000-0000-0000-000000000005', 'moderator', 'Moderator', true),
  ('00000000-0000-0000-0000-000000000006', 'alumni', 'Alumni', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
  ('00000000-0000-0000-0000-000000000001', 'content.read'),
  ('00000000-0000-0000-0000-000000000004', 'content.read'),
  ('00000000-0000-0000-0000-000000000004', 'members.read'),
  ('00000000-0000-0000-0000-000000000005', 'content.read'),
  ('00000000-0000-0000-0000-000000000005', 'members.read'),
  ('00000000-0000-0000-0000-000000000006', 'content.read')
ON CONFLICT DO NOTHING;

-- officer defaults
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-0000-0000-000000000002', "key" FROM "permissions"
WHERE "key" IN (
  'admin.access', 'signups.review', 'signups.approve', 'provisioning.retry',
  'members.read', 'members.read.restricted', 'forms.read', 'content.read',
  'alumni.review', 'alumni.approve'
)
ON CONFLICT DO NOTHING;

-- admin gets every permission
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-0000-0000-000000000003', "key" FROM "permissions"
ON CONFLICT DO NOTHING;

-- initial published signup form (dynamic fields only; base fields are locked in the renderer)
INSERT INTO "form_schemas" ("form_key", "version", "status", "season", "fields", "published_at") VALUES (
  'signup', 1, 'published', '2026-2027',
  '{"fields":[
    {"key":"college","label":"College","type":"select","required":true,"order":1,"options":[
      {"value":"applied_health_sciences","label":"College of Applied Health Sciences"},
      {"value":"architecture_design_arts","label":"College of Architecture, Design, and the Arts"},
      {"value":"business_administration","label":"College of Business Administration"},
      {"value":"education","label":"College of Education"},
      {"value":"engineering","label":"College of Engineering"},
      {"value":"honors","label":"Honors College"},
      {"value":"liberal_arts_sciences","label":"College of Liberal Arts and Sciences"},
      {"value":"nursing","label":"College of Nursing"},
      {"value":"pharmacy","label":"Retzky College of Pharmacy"},
      {"value":"public_health","label":"School of Public Health"},
      {"value":"urban_planning_public_affairs","label":"College of Urban Planning and Public Affairs"},
      {"value":"teacher_education","label":"Council on Teacher Education"},
      {"value":"other","label":"Other"}]},
    {"key":"major","label":"Major","type":"text","required":true,"order":2,"maxLength":120},
    {"key":"year_in_school","label":"Year in school","type":"select","required":true,"order":3,"options":[
      {"value":"freshman","label":"Freshman"},
      {"value":"sophomore","label":"Sophomore"},
      {"value":"junior","label":"Junior"},
      {"value":"senior","label":"Senior"},
      {"value":"grad","label":"Graduate student"},
      {"value":"alumni","label":"Alum"},
      {"value":"faculty","label":"Faculty"}
      ]},
    {"key":"grad_year","label":"Expected graduation year","type":"number","required":true,"order":4,"min":1950,"max":2040},
    {"key":"sig_interest","label":"Interest in SIGs","type":"multiselect","required":false,"order":5,"options":[
      {"value":"sig-ai","label":"SIG AI"},
      {"value":"sig-algotrading","label":"SIG Algorithmic Trading"},
      {"value":"sig-cybersecurity","label":"SIG Cybersecurity"},
      {"value":"sig-game","label":"SIG Game"},
      {"value":"sig-hacks","label":"SIG Hacks"},
      {"value":"sig-indiedev","label":"SIG Indie Dev"},
      {"value":"sig-jobs","label":"SIG Jobs"},
      {"value":"sig-math","label":"SIG Math"},
      {"value":"sig-mobiledev","label":"SIG Mobile Development"},
      {"value":"sig-pcbuild","label":"SIG PC Build"},
      {"value":"sig-sysadmin","label":"SIG SysAdmin"},
      {"value":"sig-systems","label":"SIG Systems"},
      {"value":"sig-virtualreality","label":"SIG Virtual Reality"},
      {"value":"sig-webdev","label":"SIG WebDev"}]},
    {"key":"internships","label":"How many internships have you had?","type":"number","required":true,"order":6,"min":0,"max":100}
  ]}'::jsonb,
  now()
)
ON CONFLICT ("form_key", "version") DO NOTHING;
