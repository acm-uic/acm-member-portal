import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { auth as portalAuth } from "./auth";
import type { PortalDb } from "./db";
import { account, user } from "./db/schema";

const baseURL = "http://localhost:5173";
const tenantId = "00000000-0000-4000-8000-000000000001";
const existingOid = "00000000-0000-4000-8000-000000000002";
const newOid = "00000000-0000-4000-8000-000000000003";
const oldEmail = "shared@example.com";
const newEmail = "changed@example.com";

describe("portal Microsoft email reconciliation", () => {
  let auth: typeof portalAuth;
  let db: PortalDb;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DATA_DIR", "");
    vi.stubEnv("BETTER_AUTH_URL", baseURL);
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "test-only-secret-not-for-production-at-all",
    );
    vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("MICROSOFT_TENANT_ID", tenantId);
    ({ db } = await import("./db"));
    ({ auth } = await import("./auth"));
  });

  afterAll(async () => {
    await globalThis.__pgliteClient?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await db.delete(user);
    await db.insert(user).values({
      id: "existing",
      name: "Saved Portal Name",
      username: "existing",
      email: oldEmail,
      emailVerified: true,
      entraOid: existingOid,
    });
    await db.insert(account).values({
      id: "existing-microsoft",
      userId: "existing",
      accountId: existingOid,
      providerId: "microsoft",
      issuer: "local:oauth:microsoft",
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function signIn({
    oid,
    upn,
    mail,
    graphOid = oid,
    tid = tenantId,
    graphStatus = 200,
  }: {
    oid: string;
    upn: string;
    mail: string;
    graphOid?: string;
    tid?: string;
    graphStatus?: number;
  }) {
    const payload = Buffer.from(
      JSON.stringify({
        oid,
        tid,
        preferred_username: upn,
        email: oldEmail,
        name: "Directory Name",
        email_verified: true,
      }),
    ).toString("base64url");
    const idToken = `eyJhbGciOiJSUzI1NiJ9.${payload}.c2ln`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (
          url.hostname === "login.microsoftonline.com" &&
          url.pathname.endsWith("/token")
        ) {
          return Response.json({
            access_token: "graph-token",
            id_token: idToken,
          });
        }
        if (
          url.hostname === "graph.microsoft.com" &&
          url.pathname === "/v1.0/me"
        ) {
          return Response.json(
            { id: graphOid, mail, userPrincipalName: upn },
            { status: graphStatus },
          );
        }
        throw new Error(
          `Unexpected OAuth request to ${url.hostname}${url.pathname}`,
        );
      }),
    );

    const start = await auth.api.signInSocial({
      body: { provider: "microsoft", callbackURL: `${baseURL}/dashboard/` },
      asResponse: true,
    });
    expect(start.ok).toBe(true);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();
    const cookieHeader = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; ");
    const callback = await auth.handler(
      new Request(
        `${baseURL}/api/auth/callback/microsoft?code=code&state=${encodeURIComponent(state!)}`,
        { headers: { cookie: cookieHeader(start) } },
      ),
    );
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(callback) }),
    });
    return { session, location: callback.headers.get("location") };
  }

  it("signs in two separate directory users and reconciles both email addresses", async () => {
    const newcomer = {
      oid: newOid,
      upn: "newcomer@acmuic.org",
      mail: oldEmail,
    };
    const first = await signIn(newcomer);
    expect(first.session?.user).toMatchObject({
      email: newcomer.upn,
      emailVerified: false,
    });
    const newcomerId = first.session!.user.id;
    expect(newcomerId).not.toBe("existing");
    const [existingBefore] = await db
      .select()
      .from(user)
      .where(eq(user.id, "existing"));
    expect(existingBefore?.email).toBe(oldEmail);

    const existing = await signIn({
      oid: existingOid,
      upn: "existing@acmuic.org",
      mail: newEmail,
    });
    expect(existing.session?.user).toMatchObject({
      id: "existing",
      email: newEmail,
      name: "Saved Portal Name",
      emailVerified: false,
    });
    const second = await signIn(newcomer);
    expect(second.session?.user).toMatchObject({
      id: newcomerId,
      email: oldEmail,
    });
    expect(
      await db
        .select({ userId: account.userId, oid: account.accountId })
        .from(account),
    ).toEqual(
      expect.arrayContaining([
        { userId: "existing", oid: existingOid },
        { userId: newcomerId, oid: newOid },
      ]),
    );
  });

  it("keeps a newer portal edit until the directory returns that address", async () => {
    const editedEmail = "edited@example.com";
    await db
      .update(user)
      .set({
        email: editedEmail,
        entraSyncedEmail: oldEmail,
        emailVerified: false,
      });
    const profile = { oid: existingOid, upn: "existing@acmuic.org" };
    const stale = await signIn({ ...profile, mail: oldEmail });
    expect(stale.session?.user).toMatchObject({
      email: editedEmail,
      emailVerified: false,
    });
    await signIn({ ...profile, mail: editedEmail });
    const next = await signIn({ ...profile, mail: newEmail });
    expect(next.session?.user.email).toBe(newEmail);
  });

  it.each([{ graphOid: newOid }, { graphStatus: 503 }])(
    "preserves the linked account email when Graph cannot supply its profile (%j)",
    async (graphResult) => {
      const result = await signIn({
        oid: existingOid,
        upn: "existing@acmuic.org",
        mail: newEmail,
        ...graphResult,
      });
      expect(result.session?.user).toMatchObject({
        id: "existing",
        email: oldEmail,
      });
    },
  );

  it("does not sign in to another account even if both candidate addresses are taken", async () => {
    await db.insert(user).values({
      id: "other",
      name: "Other",
      email: "newcomer@acmuic.org",
      emailVerified: true,
    });
    const result = await signIn({
      oid: newOid,
      upn: "newcomer@acmuic.org",
      mail: oldEmail,
    });
    expect(result.session).toBeNull();
    expect(result.location).toContain("error=");
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it("rejects a different tenant before changing the email", async () => {
    const result = await signIn({
      oid: existingOid,
      upn: "existing@acmuic.org",
      mail: newEmail,
      tid: newOid,
    });
    expect(result.session).toBeNull();
    const [existing] = await db.select().from(user);
    expect(existing?.email).toBe(oldEmail);
  });
});
