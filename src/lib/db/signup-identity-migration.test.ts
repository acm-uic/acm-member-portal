import { readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySqlMigrations } from "./migrate";

const migration = "0007_signup_pending_identity_uniqueness.sql";
const sharedNetids = "0008_shared_netids.sql";

describe("signup username uniqueness and shared NetIDs", () => {
  let client: PGlite;
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE _migrations (name text PRIMARY KEY);
      CREATE TABLE signup_submissions (
        id text PRIMARY KEY, netid text NOT NULL, username text NOT NULL,
        status text NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE "user" (id text PRIMARY KEY, netid text UNIQUE, username text UNIQUE);
    `);
    for (const name of readdirSync(
      new URL("../../../drizzle/", import.meta.url),
    )) {
      if (
        name.endsWith(".sql") &&
        name !== migration &&
        name !== sharedNetids
      ) {
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
        if (params?.length) {
          const result = await client.query(text, params);
          return { rows: result.rows as Record<string, unknown>[] };
        }
        const results = await client.exec(text);
        return {
          rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[],
        };
      },
      { useAdvisoryLock: false },
    );
  }
  it("keeps pending usernames unique while allowing duplicate NetIDs on signups and accounts", async () => {
    await client.exec(`INSERT INTO signup_submissions (id, netid, username) VALUES
      ('first', 'shared-netid', 'first-username'), ('second', 'shared-netid', 'second-username');`);
    await migrate();
    await client.exec(`INSERT INTO "user" (id, netid, username) VALUES
      ('first', 'shared-netid', 'first-username'), ('second', 'shared-netid', 'second-username');`);
    await expect(
      client.exec(`INSERT INTO signup_submissions (id, netid, username)
      VALUES ('duplicate', 'shared-netid', 'first-username')`),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "signup_submissions_pending_username_key",
    });
    await expect(
      client.exec(
        `UPDATE signup_submissions SET username = 'first-username' WHERE id = 'second'`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.exec(`INSERT INTO "user" (id, netid, username)
      VALUES ('duplicate', 'shared-netid', 'first-username')`),
    ).rejects.toMatchObject({ code: "23505" });
    await client.exec(`UPDATE signup_submissions SET status = 'approved' WHERE id = 'first';
      INSERT INTO signup_submissions (id, netid, username) VALUES ('reused', 'shared-netid', 'first-username');`);
    await migrate();
    expect(
      (
        await client.query(
          "SELECT name FROM _migrations WHERE name IN ($1, $2)",
          [migration, sharedNetids],
        )
      ).rows,
    ).toHaveLength(2);
  });
  it("preserves existing duplicate pending usernames and rolls back until they are resolved", async () => {
    await client.exec(`INSERT INTO signup_submissions (id, netid, username) VALUES
      ('first', 'shared-netid', 'same-username'), ('second', 'shared-netid', 'same-username');`);
    const before = await client.query(
      "SELECT * FROM signup_submissions ORDER BY id",
    );
    await expect(migrate()).rejects.toMatchObject({ code: "23505" });
    expect(
      (await client.query("SELECT * FROM signup_submissions ORDER BY id")).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query("SELECT name FROM _migrations WHERE name = $1", [
          migration,
        ])
      ).rows,
    ).toEqual([]);
    await client.exec(
      "UPDATE signup_submissions SET status = 'denied' WHERE id = 'second'",
    );
    await migrate();
  });
  it.each(["user_netid_key", "user_netid_unique"])(
    "removes previously applied NetID uniqueness from %s and pending signups",
    async (constraint) => {
      await client.exec(`ALTER TABLE "user" DROP CONSTRAINT user_netid_key;
      ALTER TABLE "user" ADD CONSTRAINT ${constraint} UNIQUE (netid);
      CREATE UNIQUE INDEX signup_submissions_pending_netid_key ON signup_submissions (netid) WHERE status = 'pending';
      CREATE UNIQUE INDEX signup_submissions_pending_username_key ON signup_submissions (username) WHERE status = 'pending';
      INSERT INTO signup_submissions (id, netid, username) VALUES ('first', 'shared-netid', 'first-username');
      INSERT INTO "user" (id, netid, username) VALUES ('first', 'shared-netid', 'first-username');`);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
        migration,
      ]);
      await migrate();
      await client.exec(`INSERT INTO signup_submissions (id, netid, username) VALUES ('second', 'shared-netid', 'second-username');
      INSERT INTO "user" (id, netid, username) VALUES ('second', 'shared-netid', 'second-username');`);
      expect(
        (await client.query("SELECT * FROM signup_submissions")).rows,
      ).toHaveLength(2);
      expect((await client.query('SELECT * FROM "user"')).rows).toHaveLength(2);
    },
  );
});
