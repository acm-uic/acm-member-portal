import { readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySqlMigrations } from "./migrate";

const migration = "0010_shared_username_claims.sql";
const signupId = "00000000-0000-0000-0000-000000000101";
describe("shared username claim migration", () => {
  let client: PGlite;
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`CREATE TABLE _migrations (name text PRIMARY KEY);
      CREATE TABLE "user" (id text PRIMARY KEY, username text UNIQUE, netid text);
      CREATE TABLE signup_submissions (id uuid PRIMARY KEY, username text NOT NULL,
        status text NOT NULL DEFAULT 'pending', netid text);`);
    for (const name of readdirSync(
      new URL("../../../drizzle/", import.meta.url),
    )) {
      if (name.endsWith(".sql") && name !== migration) {
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          name,
        ]);
      }
    }
  });
  afterEach(async () => {
    await client.close();
  });
  async function migrate() {
    await applySqlMigrations(
      async (text, params) => {
        if (params?.length)
          return {
            rows: (await client.query(text, params)).rows as Record<
              string,
              unknown
            >[],
          };
        const results = await client.exec(text);
        return {
          rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[],
        };
      },
      { useAdvisoryLock: false },
    );
  }
  it("backfills existing members and their approved signups and repeats safely", async () => {
    await client.query(
      `INSERT INTO signup_submissions (id, username, status, netid)
      VALUES ($1, 'account', 'approved', 'shared')`,
      [signupId],
    );
    await client.exec(`INSERT INTO "user" (id, username, netid)
      VALUES ('member', 'account', 'shared'), ('second', 'second-account', 'shared');`);
    await migrate();
    expect(
      (
        await client.query(
          "SELECT * FROM username_claims WHERE username = 'account'",
        )
      ).rows,
    ).toEqual([
      {
        username: "account",
        signup_submission_id: signupId,
        user_id: "member",
      },
    ]);
    await migrate();
    expect(
      (await client.query("SELECT * FROM username_claims")).rows,
    ).toHaveLength(2);
    await client.exec(
      `UPDATE "user" SET username = 'account' WHERE id = 'member'`,
    );
  });
  it("reserves an approved username for first login and rejects another member's rename", async () => {
    await client.query(
      `INSERT INTO signup_submissions (id, username, status) VALUES ($1, 'reserved', 'approved')`,
      [signupId],
    );
    await client.exec(
      `INSERT INTO "user" (id, username) VALUES ('member', 'original')`,
    );
    await migrate();
    await expect(
      client.exec(
        `UPDATE "user" SET username = 'reserved' WHERE id = 'member'`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "username_claims_username_key",
    });
    await client.exec(
      `INSERT INTO "user" (id, username) VALUES ('applicant', 'reserved')`,
    );
    expect(
      (
        await client.query(
          "SELECT user_id FROM username_claims WHERE username = 'reserved'",
        )
      ).rows,
    ).toEqual([{ user_id: "applicant" }]);
    await client.exec(`DELETE FROM "user" WHERE id = 'applicant'`);
    expect(
      (
        await client.query(
          "SELECT signup_submission_id, user_id FROM username_claims WHERE username = 'reserved'",
        )
      ).rows,
    ).toEqual([{ signup_submission_id: signupId, user_id: null }]);
    await client.exec("DELETE FROM signup_submissions");
    expect(
      (
        await client.query(
          "SELECT * FROM username_claims WHERE username = 'reserved'",
        )
      ).rows,
    ).toEqual([]);
  });
  it("rolls back a pending signup/member conflict without rewriting either row", async () => {
    await client.query(
      `INSERT INTO signup_submissions (id, username) VALUES ($1, 'conflict')`,
      [signupId],
    );
    await client.exec(
      `INSERT INTO "user" (id, username) VALUES ('member', 'conflict')`,
    );
    await expect(migrate()).rejects.toMatchObject({
      code: "23505",
      constraint: "username_claims_username_key",
    });
    expect(
      (await client.query("SELECT username FROM signup_submissions")).rows,
    ).toEqual([{ username: "conflict" }]);
    expect((await client.query('SELECT username FROM "user"')).rows).toEqual([
      { username: "conflict" },
    ]);
    expect(
      (
        await client.query("SELECT name FROM _migrations WHERE name = $1", [
          migration,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await client.query("SELECT to_regclass('username_claims') AS claims"))
        .rows,
    ).toEqual([{ claims: null }]);
    await client.exec("UPDATE signup_submissions SET status = 'denied'");
    await migrate();
  });
  it("blocks account insertion on pending claims and releases claims after denial or deletion", async () => {
    await migrate();
    await client.query(
      `INSERT INTO signup_submissions (id, username) VALUES ($1, 'reserved')`,
      [signupId],
    );
    await expect(
      client.exec(
        `INSERT INTO "user" (id, username) VALUES ('applicant', 'reserved')`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "username_claims_username_key",
    });
    await client.exec("UPDATE signup_submissions SET status = 'denied'");
    await client.exec(
      `INSERT INTO "user" (id, username) VALUES ('applicant', 'reserved')`,
    );
    await expect(
      client.query(
        `UPDATE signup_submissions SET status = 'approved' WHERE id = $1`,
        [signupId],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "username_claims_username_key",
    });
    await client.exec(`DELETE FROM "user" WHERE id = 'applicant'`);
    expect((await client.query("SELECT * FROM username_claims")).rows).toEqual(
      [],
    );
    await client.exec("UPDATE signup_submissions SET status = 'approved'");
    expect(
      (await client.query("SELECT * FROM username_claims")).rows,
    ).toHaveLength(1);
  });
});
