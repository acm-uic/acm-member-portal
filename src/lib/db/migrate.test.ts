import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applySqlMigrations } from "./migrate";

describe("applySqlMigrations (PGlite)", () => {
	it("applies 0000_initial.sql and seeds the published signup form", async () => {
		const client = new PGlite();
		const query = async (text: string, params?: unknown[]) => {
			if (params?.length) {
				const result = await client.query(text, params);
				return { rows: (result.rows ?? []) as Record<string, unknown>[] };
			}
			const results = await client.exec(text);
			const last = results[results.length - 1] as
				| { rows?: Record<string, unknown>[] }
				| undefined;
			return { rows: last?.rows ?? [] };
		};

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

		await client.close();
	});
});

describe("mail stub", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
		delete process.env.SMTP_HOST;
		delete process.env.MAIL_DIR;
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
