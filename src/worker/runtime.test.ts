import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Vite resolves extensionless imports and ~ aliases. Run separate Node
// processes so these tests exercise the same module resolution as the pods.
describe("native Node worker runtime", () => {
  let workDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "portal-worker-"));
    env = {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PGLITE_DATA_DIR: join(workDir, "db"),
      MAIL_DIR: join(workDir, "mail"),
      BETTER_AUTH_SECRET: "test-secret-at-least-32-characters!!",
      BETTER_AUTH_URL: "http://localhost:5173",
      ORIGIN: "http://localhost:5173",
    };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function runNode(args: string[]) {
    return execFileAsync("node", ["--experimental-strip-types", ...args], {
      env,
      timeout: 20_000,
    });
  }

  it("loads the worker entrypoint and runs the alumni digest", async () => {
    const { stdout } = await runNode(["src/worker/index.ts", "alumni"]);
    expect(stdout).toContain("alumni digest: no candidates");
  }, 30_000);

  it("provisions a signup and loads the local auth import chain", async () => {
    await runNode(["scripts/migrate.ts"]);
    const client = new PGlite(env.PGLITE_DATA_DIR!);
    const eventId = crypto.randomUUID();
    try {
      const { rows: submissions } = await client.query<{ id: string }>(`
				INSERT INTO signup_submissions
					(schema_version_id, first_name, last_name, netid, username, email, answers, status)
				SELECT id, 'Test', 'User', 'tuser', 'tuser', 'tuser@example.com', '{}', 'approved'
				FROM form_schemas WHERE form_key = 'signup' LIMIT 1
				RETURNING id
			`);
      await client.query(
        `INSERT INTO provisioning_events (id, submission_id, payload)
				 VALUES ($1, $2, $3)`,
        [
          eventId,
          submissions[0]!.id,
          JSON.stringify({
            netid: "tuser",
            username: "tuser",
            firstName: "Test",
            lastName: "User",
            displayName: "Test User",
            email: "tuser@example.com",
            eventId,
          }),
        ],
      );
    } finally {
      await client.close();
    }

    const { stdout, stderr } = await runNode([
      "--input-type=module",
      "-e",
      `import { drainOnce } from './src/worker/provisioning.ts';
			 try {
			   if (!await drainOnce()) throw new Error('No event processed');
			 } finally {
			   await globalThis.__pgliteClient?.close();
			 }`,
    ]);
    expect(stdout).toContain("[dev] local member login: tuser@example.com");
    expect(stderr).not.toContain("could not seed member login");

    const resultClient = new PGlite(env.PGLITE_DATA_DIR!);
    try {
      const event = await resultClient.query<{ status: string }>(
        "SELECT status FROM provisioning_events WHERE id = $1",
        [eventId],
      );
      expect(event.rows[0]?.status).toBe("provisioned");
      const member = await resultClient.query<{ username: string }>(
        'SELECT username FROM "user" WHERE email = $1',
        ["tuser@example.com"],
      );
      expect(member.rows[0]?.username).toBe("tuser");
    } finally {
      await resultClient.close();
    }

    const mailDir = env.MAIL_DIR!;
    const mail = readdirSync(mailDir);
    expect(mail).toHaveLength(1);
    expect(readFileSync(join(mailDir, mail[0]!), "utf8")).toContain(
      "One-time password:",
    );
  }, 30_000);
});
