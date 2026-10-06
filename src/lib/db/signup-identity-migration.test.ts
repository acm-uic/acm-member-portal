import { readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySqlMigrations } from "./migrate";

const migration = "0007_signup_pending_identity_uniqueness.sql";

describe("pending signup identity migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE _migrations (name text PRIMARY KEY);
      CREATE TABLE signup_submissions (
        id text PRIMARY KEY, netid text NOT NULL, username text NOT NULL,
        status text NOT NULL DEFAULT 'pending'
      );
    `);
    // Model a database immediately before this migration, with its existing rows.
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

  it("rejects duplicate inserts and updates while allowing reuse after review", async () => {
    await migrate();
    await client.exec(`INSERT INTO signup_submissions (id, netid, username) VALUES
      ('first', 'first-netid', 'first-username'), ('second', 'second-netid', 'second-username');`);
    for (const field of ["netid", "username"]) {
      const constraint = `signup_submissions_pending_${field}_key`;
      await expect(
        client.query(
          `INSERT INTO signup_submissions (id, netid, username) VALUES ('duplicate', $1, $2)`,
          [
            field === "netid" ? "first-netid" : "new-netid",
            field === "username" ? "first-username" : "new-username",
          ],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint });
      await expect(
        client.exec(
          `UPDATE signup_submissions SET ${field} = 'first-${field}' WHERE id = 'second'`,
        ),
      ).rejects.toMatchObject({ code: "23505", constraint });
    }
    await client.exec(`UPDATE signup_submissions SET status = 'approved' WHERE id = 'first';
      INSERT INTO signup_submissions (id, netid, username) VALUES ('reused', 'first-netid', 'first-username');
      INSERT INTO signup_submissions (id, netid, username, status) VALUES
        ('historical', 'first-netid', 'first-username', 'denied');`);
    await expect(
      client.exec(
        `UPDATE signup_submissions SET status = 'pending' WHERE id = 'historical'`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await migrate();
    const { rows } = await client.query(
      "SELECT name FROM _migrations WHERE name = $1",
      [migration],
    );
    expect(rows).toEqual([{ name: migration }]);
  });

  it.each(["netid", "username"] as const)(
    "preserves existing duplicate %s rows and rolls back until an admin resolves them",
    async (field) => {
      await client.query(
        `INSERT INTO signup_submissions (id, netid, username) VALUES
        ('first', 'first-netid', 'first-username'), ('second', $1, $2)`,
        [
          field === "netid" ? "first-netid" : "second-netid",
          field === "username" ? "first-username" : "second-username",
        ],
      );
      const before = await client.query(
        "SELECT * FROM signup_submissions ORDER BY id",
      );
      await expect(migrate()).rejects.toMatchObject({ code: "23505" });
      expect(
        (await client.query("SELECT * FROM signup_submissions ORDER BY id"))
          .rows,
      ).toEqual(before.rows);
      expect(
        (
          await client.query("SELECT name FROM _migrations WHERE name = $1", [
            migration,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(`SELECT indexname FROM pg_indexes
        WHERE indexname IN ('signup_submissions_pending_netid_key', 'signup_submissions_pending_username_key')`)
        ).rows,
      ).toEqual([]);
      await client.exec(
        "UPDATE signup_submissions SET status = 'denied' WHERE id = 'second'",
      );
      await migrate();
      expect(
        (
          await client.query(`SELECT indexname FROM pg_indexes
        WHERE indexname IN ('signup_submissions_pending_netid_key', 'signup_submissions_pending_username_key')`)
        ).rows,
      ).toHaveLength(2);
    },
  );
});
