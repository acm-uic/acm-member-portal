import { randomBytes } from "node:crypto";
import type { DbOrTx, ProvisioningEvent } from "./outbox.ts";

type AccountPayload = {
  netid: string;
  username?: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  email: string;
  displayName: string;
  uin?: string;
  department?: string;
  company?: string;
  eventId: string;
};

/** Create or recover event-owned initial credentials. Never persist the password. */
export async function provisionAccount(
  event: ProvisioningEvent,
  fetchImpl: typeof fetch = fetch,
) {
  if (!process.env.WINDOWS_API_URL && process.env.NODE_ENV === "production") {
    throw new Error("Directory provisioning is not configured.");
  }
  const payload = event.payload as AccountPayload;
  const username = payload.username || payload.netid;
  const body = process.env.WINDOWS_API_URL
    ? await callWindowsApi(
        {
          ...payload,
          username,
          eventId: event.id,
          retryCredentialDelivery: true,
        },
        fetchImpl,
      )
    : stubProvision({ username });
  return { payload, username, body };
}

function stubProvision(payload: { username: string }): {
  samAccountName: string;
  existed: boolean;
  oneTimePassword: string;
} {
  const oneTimePassword = `dev-${randomBytes(6).toString("hex")}`;
  console.log(`[provision stub] created ${payload.username}`);
  return {
    samAccountName: payload.username,
    existed: false,
    oneTimePassword,
  };
}

export async function seedLocalMemberLogin(
  args: {
    email: string;
    name: string;
    password: string;
    netid: string;
    username: string;
    uin?: string;
    firstName: string;
    lastName: string;
    preferredName?: string;
    reissue?: boolean;
  },
  client?: DbOrTx,
): Promise<void> {
  try {
    const { auth } = await import("../auth.ts");
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("../db/index.ts");
    const { user, account } = await import("../db/schema.ts");
    const database = client ?? db;

    const [existing] = await database
      .select({ id: user.id, username: user.username })
      .from(user)
      .where(eq(user.email, args.email))
      .limit(1);
    if (existing) {
      if (args.reissue && existing.username !== args.username) {
        throw new Error("A different development account uses this email.");
      }
      if (args.reissue && existing.username === args.username) {
        const { hashPassword } = await import("better-auth/crypto");
        const updated = await database
          .update(account)
          .set({
            password: await hashPassword(args.password),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(account.userId, existing.id),
              eq(account.providerId, "credential"),
            ),
          )
          .returning({ id: account.id });
        if (!updated.length) {
          throw new Error("The development user has no credential account.");
        }
      }
      return;
    }
    // Auth signup uses its own transactions. Create first, then update its hash
    // under the worker's claim lock before delivery.
    if (client) throw new Error("The development login was not created.");

    const result = await auth.api.signUpEmail({
      body: {
        email: args.email,
        password: args.password,
        name: args.name,
        netid: args.netid,
        username: args.username,
        uin: args.uin,
        firstName: args.firstName,
        lastName: args.lastName,
        preferredName: args.preferredName,
      } as {
        email: string;
        password: string;
        name: string;
        netid: string;
        username: string;
        uin?: string;
        firstName: string;
        lastName: string;
        preferredName?: string;
      },
    });
    if (!result?.user) {
      throw new Error("The development login was not created.");
    }
    if (result?.user) {
      await db
        .update(user)
        .set({
          netid: args.netid,
          username: args.username,
          uin: args.uin ?? null,
          firstName: args.firstName,
          lastName: args.lastName,
          preferredName: args.preferredName ?? null,
        })
        .where(eq(user.id, result.user.id));
      console.log(
        `[dev] local member login: ${args.email} (temporary credentials issued)`,
      );
    }
  } catch {
    if (args.reissue)
      throw new Error(
        "Could not create the development login for these credentials.",
      );
    console.warn("[dev] could not seed member login");
  }
}

async function callWindowsApi(
  payload: {
    netid: string;
    username: string;
    firstName: string;
    lastName: string;
    preferredName?: string;
    email: string;
    displayName: string;
    uin?: string;
    department?: string;
    company?: string;
    eventId: string;
    retryCredentialDelivery: boolean;
  },
  fetchImpl: typeof fetch,
): Promise<{
  samAccountName: string;
  existed: boolean;
  oneTimePassword?: string;
}> {
  const API_URL = process.env.WINDOWS_API_URL!;
  const API_TOKEN = process.env.WINDOWS_API_TOKEN!;

  const res = await fetchImpl(`${API_URL}/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Provisioning API ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }

  const body = await res.json();
  if (
    body?.samAccountName !== payload.username ||
    typeof body.existed !== "boolean" ||
    (body.oneTimePassword != null &&
      (typeof body.oneTimePassword !== "string" || !body.oneTimePassword)) ||
    (!body.existed &&
      (typeof body.oneTimePassword !== "string" || !body.oneTimePassword))
  ) {
    throw new Error(
      "Provisioning API returned an invalid account-creation response.",
    );
  }
  return body as {
    samAccountName: string;
    existed: boolean;
    oneTimePassword?: string;
  };
}
