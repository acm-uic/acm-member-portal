import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applySqlMigrations } from "./migrate";

function pgliteQuery(client: PGlite) {
	return async (text: string, params?: unknown[]) => {
		if (params?.length) {
			const result = await client.query(text, params);
			return { rows: (result.rows ?? []) as Record<string, unknown>[] };
		}
		const results = await client.exec(text);
		const last = results[results.length - 1] as
			{ rows?: Record<string, unknown>[] } | undefined;
		return { rows: last?.rows ?? [] };
	};
}

async function signupNameColumns(query: ReturnType<typeof pgliteQuery>) {
	const { rows } = await query(
		`SELECT column_name FROM information_schema.columns
     WHERE table_name = 'signup_submissions' ORDER BY ordinal_position`,
	);
	return rows.map((r) => String(r.column_name));
}

describe("applySqlMigrations (PGlite)", () => {
	it("applies 0000_initial.sql and seeds the published signup form", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);

		await applySqlMigrations(query, { useAdvisoryLock: false });

		const { rows } = await query(
			`SELECT form_key, version, status, season, fields
       FROM form_schemas
       WHERE form_key = 'signup' AND status = 'published'
       ORDER BY version DESC LIMIT 1`,
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].season).toBe("2026-2027");
		expect(rows[0].status).toBe("published");

		const definition = rows[0].fields as {
			fields: { key: string; options?: { value: string }[] }[];
		};
		const keys = definition.fields.map((f) => f.key);
		expect(keys).toContain("college");
		expect(keys).toContain("major");
		expect(keys).toContain("grad_year");

		const college = definition.fields.find((f) => f.key === "college");
		const collegeValues = (college?.options ?? []).map((o) => o.value);
		expect(collegeValues).toEqual(
			expect.arrayContaining([
				"engineering",
				"liberal_arts_sciences",
				"business_administration",
				"pharmacy",
				"honors",
			]),
		);

		const cols = await signupNameColumns(query);
		expect(cols).toEqual(
			expect.arrayContaining([
				"first_name",
				"last_name",
				"preferred_name",
				"username",
				"discord_id",
				"discord_username",
				"discord_in_guild",
			]),
		);
		expect(cols).not.toContain("display_name");

		const { rows: sigRows } = await query(
			`SELECT key, display_name, active FROM sigs ORDER BY key`,
		);
		expect(sigRows).toHaveLength(14);
		expect(sigRows.map((r) => String(r.key))).toEqual(
			expect.arrayContaining(["sig-ai", "sig-webdev", "sig-systems"]),
		);

		const { rows: leaderTable } = await query(
			`SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sig_leaders'`,
		);
		expect(leaderTable).toHaveLength(1);

		const { rows: userCols } = await query(
			`SELECT column_name FROM information_schema.columns
       WHERE table_name = 'user' AND column_name LIKE 'discord%'`,
		);
		expect(userCols.map((r) => String(r.column_name)).sort()).toEqual([
			"discord_id",
			"discord_username",
		]);

		const { rows: issuerCols } = await query(
			`SELECT column_name FROM information_schema.columns
       WHERE table_name = 'account' AND column_name = 'issuer'`,
		);
		expect(issuerCols).toHaveLength(1);

		await client.close();
	});

	it("defaults existing provisioning work to email when adding manual delivery", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);
		try {
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await query(
				"ALTER TABLE provisioning_events DROP COLUMN credential_delivery_mode, DROP COLUMN credential_reveal_token",
			);
			await query('DELETE FROM "_migrations" WHERE name = $1', [
				"0012_manual_credential_delivery.sql",
			]);
			const { rows: submissions } =
				await query(`INSERT INTO signup_submissions (schema_version_id, first_name, last_name, netid, username, email, answers, status)
        SELECT id, 'Alex', 'Smith', 'asmith', 'asmith', 'alex@example.com', '{}', 'approved' FROM form_schemas WHERE form_key = 'signup' LIMIT 1 RETURNING id`);
			await query(
				"INSERT INTO provisioning_events (submission_id, payload, status, credential_delivery_status) VALUES ($1, '{}', 'failed', 'pending')",
				[submissions[0].id],
			);
			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows } = await query(
				"SELECT credential_delivery_mode, credential_reveal_token, credential_delivery_status, status FROM provisioning_events",
			);
			expect(rows).toEqual([
				{
					credential_delivery_mode: "email",
					credential_reveal_token: null,
					credential_delivery_status: "pending",
					status: "failed",
				},
			]);
		} finally {
			await client.close();
		}
	});

	it("preserves queued events when adding credential delivery progress", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);
		try {
			await applySqlMigrations(query, { useAdvisoryLock: false });
			// Reconstruct the outbox before the delivery-state migration.
			await query(
				"ALTER TABLE provisioning_events DROP COLUMN credential_delivery_status",
			);
			await query('DELETE FROM "_migrations" WHERE name = $1', [
				"0011_credential_delivery_status.sql",
			]);
			const { rows: submissions } = await query(`
				INSERT INTO signup_submissions
				  (schema_version_id, first_name, last_name, netid, username, email, answers, status)
				SELECT id, 'Alex', 'Morgan', 'amorga42', 'amorga42', 'alex@example.com', '{}', 'approved'
				FROM form_schemas WHERE form_key = 'signup' AND status = 'published'
				LIMIT 1 RETURNING id`);
			await query(
				`INSERT INTO provisioning_events
				(submission_id, payload, status, attempts, last_error)
				VALUES ($1, '{"username":"amorga42"}', 'failed', 3, 'SMTP unavailable')`,
				[submissions[0].id],
			);

			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows } =
				await query(`SELECT status, attempts, last_error, payload,
				credential_delivery_status FROM provisioning_events`);
			expect(rows).toEqual([
				{
					status: "failed",
					attempts: 3,
					last_error: "SMTP unavailable",
					payload: { username: "amorga42" },
					credential_delivery_status: "pending",
				},
			]);
			await query(
				"UPDATE provisioning_events SET credential_delivery_status = 'delivered'",
			);
			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows: reapplied } = await query(
				"SELECT credential_delivery_status FROM provisioning_events",
			);
			expect(reapplied).toEqual([{ credential_delivery_status: "delivered" }]);
		} finally {
			await client.close();
		}
	});

	it("preserves provisioning progress while adding claim tokens and the latest-event index", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);
		try {
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await query("ALTER TABLE provisioning_events DROP COLUMN claim_token");
			await query("DROP INDEX provisioning_events_submission_latest_idx");
			await query('DELETE FROM "_migrations" WHERE name = $1', [
				"0013_provisioning_claims.sql",
			]);
			const { rows: submissions } = await query(`INSERT INTO signup_submissions
        (schema_version_id, first_name, last_name, netid, username, email, answers, status)
        SELECT id, 'Alex', 'Smith', 'asmith', 'asmith', 'alex@example.com', '{}', 'approved'
        FROM form_schemas WHERE form_key = 'signup' LIMIT 1 RETURNING id`);
			await query(
				"INSERT INTO provisioning_events (submission_id, payload, status, credential_delivery_status) VALUES ($1, '{}', 'failed', 'delivered')",
				[submissions[0].id],
			);
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows } = await query(
				"SELECT status, credential_delivery_status, claim_token FROM provisioning_events",
			);
			expect(rows).toEqual([
				{
					status: "failed",
					credential_delivery_status: "delivered",
					claim_token: null,
				},
			]);
			const { rows: indexes } = await query(
				"SELECT indexdef FROM pg_indexes WHERE indexname = 'provisioning_events_submission_latest_idx'",
			);
			expect(indexes).toHaveLength(1);
			expect(indexes[0].indexdef).toContain(
				"(submission_id, created_at DESC, id DESC)",
			);
		} finally {
			await client.close();
		}
	});

	it("adds provisioning history without changing existing errors or inventing attempts", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);
		try {
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await query("DROP TABLE provisioning_logs");
			await query("DROP INDEX provisioning_events_updated_idx");
			await query('DELETE FROM "_migrations" WHERE name = $1', [
				"0014_provisioning_logs.sql",
			]);
			const { rows: submissions } = await query(`INSERT INTO signup_submissions
        (schema_version_id, first_name, last_name, netid, username, email, answers, status)
        SELECT id, 'Alex', 'Smith', 'asmith', 'asmith', 'alex@example.com', '{}', 'approved'
        FROM form_schemas WHERE form_key = 'signup' LIMIT 1 RETURNING id`);
			await query(
				`INSERT INTO provisioning_events (submission_id, payload, status, attempts, last_error)
        VALUES ($1, '{}', 'failed', 3, 'AD create failed: Access is denied.')`,
				[submissions[0].id],
			);
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows } = await query(
				"SELECT status, attempts, last_error FROM provisioning_events",
			);
			expect(rows).toEqual([
				{
					status: "failed",
					attempts: 3,
					last_error: "AD create failed: Access is denied.",
				},
			]);
			expect((await query("SELECT * FROM provisioning_logs")).rows).toEqual([]);
		} finally {
			await client.close();
		}
	});

	it("splits legacy signup display_name into first/last/preferred", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);

		await query(`CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )`);
		await query(`CREATE TABLE "signup_submissions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "schema_version_id" uuid NOT NULL,
      "display_name" text NOT NULL,
      "netid" text NOT NULL,
      "uin" text,
      "email" text NOT NULL,
      "answers" jsonb NOT NULL,
      "status" text NOT NULL DEFAULT 'pending',
      "created_at" timestamptz NOT NULL DEFAULT now()
    )`);
		await query(
			`INSERT INTO "signup_submissions"
        ("schema_version_id", "display_name", "netid", "email", "answers")
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
			[
				"00000000-0000-0000-0000-000000000001",
				"Alex Morgan",
				"amorga42",
				"alex@example.com",
				"{}",
			],
		);
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0000_initial.sql",
		]);
		// This legacy fixture models only signup data, without member accounts.
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0010_shared_username_claims.sql",
		]);
		// This fixture also omits the provisioning outbox.
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0011_credential_delivery_status.sql",
		]);
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0012_manual_credential_delivery.sql",
		]);
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0013_provisioning_claims.sql",
		]);
		await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
			"0014_provisioning_logs.sql",
		]);

		await applySqlMigrations(query, { useAdvisoryLock: false });

		const cols = await signupNameColumns(query);
		expect(cols).toEqual(
			expect.arrayContaining(["first_name", "last_name", "preferred_name"]),
		);
		expect(cols).not.toContain("display_name");

		const { rows } = await query(
			`SELECT first_name, last_name, preferred_name FROM signup_submissions`,
		);
		expect(rows[0]).toEqual({
			first_name: "Alex",
			last_name: "Morgan",
			preferred_name: null,
		});

		await client.close();
	});

	it("repairs Microsoft NetIDs while preserving email and avoiding collisions", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);

		try {
			await applySqlMigrations(query, { useAdvisoryLock: false });
			await query('DELETE FROM "_migrations" WHERE name = $1', [
				"0006_microsoft_netid.sql",
			]);
			await query(`INSERT INTO "user" (id, name, email, netid, entra_oid) VALUES
        ('oid', 'Chase Lee', 'chase@example.com', 'clee231@acmuic.org', 'entra-chase'),
        ('linked', 'Linked', 'linked@example.com', 'linked@acmuic.org', NULL),
        ('plain', 'Plain', 'plain@example.com', 'plain', 'entra-plain'),
        ('unset', 'Unset', 'unset@example.com', NULL, 'entra-unset'),
        ('unlinked', 'Unlinked', 'unlinked@example.com', 'unlinked@example.com', NULL),
        ('owner', 'Owner', 'owner@example.com', 'taken', NULL),
        ('conflict', 'Conflict', 'conflict@example.com', 'taken@acmuic.org', 'entra-conflict'),
        ('duplicate-a', 'Duplicate A', 'duplicate-a@example.com', 'duplicate@acmuic.org', 'entra-a'),
        ('duplicate-b', 'Duplicate B', 'duplicate-b@example.com', 'duplicate@uic.edu', 'entra-b'),
        ('empty', 'Empty', 'empty@example.com', '@acmuic.org', 'entra-empty')`);
			await query(`INSERT INTO "account" (id, user_id, account_id, provider_id, issuer)
        VALUES ('ms-linked', 'linked', 'ms-id', 'microsoft', 'microsoft')`);

			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows } = await query('SELECT id, netid FROM "user" ORDER BY id');
			expect(rows).toEqual([
				{ id: "conflict", netid: "taken@acmuic.org" },
				{ id: "duplicate-a", netid: "duplicate@acmuic.org" },
				{ id: "duplicate-b", netid: "duplicate@uic.edu" },
				{ id: "empty", netid: "@acmuic.org" },
				{ id: "linked", netid: "linked" },
				{ id: "oid", netid: "clee231" },
				{ id: "owner", netid: "taken" },
				{ id: "plain", netid: "plain" },
				{ id: "unlinked", netid: "unlinked@example.com" },
				{ id: "unset", netid: null },
			]);
			const { rows: identity } = await query(
				`SELECT email, entra_oid FROM "user" WHERE id = 'oid'`,
			);
			expect(identity).toEqual([
				{ email: "chase@example.com", entra_oid: "entra-chase" },
			]);
			await applySqlMigrations(query, { useAdvisoryLock: false });
			const { rows: reapplied } = await query(
				'SELECT id, netid FROM "user" ORDER BY id',
			);
			expect(reapplied).toEqual(rows);
		} finally {
			await client.close();
		}
	});

	it("backfills account.issuer for credential and oauth rows", async () => {
		const client = new PGlite();
		const query = pgliteQuery(client);

		await query(`CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )`);
		await query(`CREATE TABLE "account" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL,
      "account_id" text NOT NULL,
      "provider_id" text NOT NULL,
      "password" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`);
		await query(
			`INSERT INTO "account" ("id", "user_id", "account_id", "provider_id")
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
			["a-cred", "u-1", "u-1", "credential", "a-dc", "u-1", "555", "discord"],
		);
		for (const name of [
			"0000_initial.sql",
			"0001_signup_name_columns.sql",
			"0002_username.sql",
			"0003_discord.sql",
			"0004_sigs.sql",
			// This account-only fixture has no signup table to index.
			"0007_signup_pending_identity_uniqueness.sql",
			"0008_shared_netids.sql",
			"0009_signup_username_reservations.sql",
			"0010_shared_username_claims.sql",
			"0011_credential_delivery_status.sql",
			"0012_manual_credential_delivery.sql",
			"0013_provisioning_claims.sql",
			"0014_provisioning_logs.sql",
		]) {
			await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [name]);
		}

		await applySqlMigrations(query, { useAdvisoryLock: false });

		const { rows } = await query(
			`SELECT provider_id, issuer FROM account ORDER BY provider_id`,
		);
		expect(rows).toEqual([
			{ provider_id: "credential", issuer: "local:credential" },
			{ provider_id: "discord", issuer: "local:oauth:discord" },
		]);

		await client.close();
	});
});

describe("mail stub", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
		delete process.env.SMTP_HOST;
		delete process.env.MAIL_DIR;
	});

	it("rejects missing production SMTP without writing or logging the password", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portal-mail-"));
		dirs.push(dir);
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("MAIL_DIR", dir);
		vi.stubEnv("SMTP_HOST", "");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { sendCredentialEmail } = await import("../mail/templates");
		await expect(
			sendCredentialEmail({
				to: "test@example.com",
				username: "test",
				oneTimePassword: "secret-otp",
			}),
		).rejects.toThrow("SMTP is not configured");
		expect(readdirSync(dir)).toEqual([]);
		expect(log).not.toHaveBeenCalled();
	});

	it("writes messages to MAIL_DIR when SMTP_HOST is unset", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portal-mail-"));
		dirs.push(dir);
		process.env.MAIL_DIR = dir;
		delete process.env.SMTP_HOST;

		// Dynamic import after env is set so the stub path is chosen
		const { sendMail } = await import("../mail/smtp");
		await sendMail({
			to: "test@example.com",
			subject: "Hello",
			text: "One-time password: secret-otp",
		});

		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const body = readFileSync(join(dir, files[0]!), "utf8");
		expect(body).toContain("test@example.com");
		expect(body).toContain("secret-otp");
	});
});
