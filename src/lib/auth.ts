import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "~/lib/db";
import { isDevLoginEnabled, isEmbeddedDb } from "~/lib/db/mode";
import { account, session, user, verification } from "~/lib/db/schema";
import { bootstrapUser } from "~/lib/auth-bootstrap";

/** Local-only defaults — never applied in production. */
function ensureDevAuthEnv(): void {
	if (process.env.NODE_ENV === "production") return;
	if (!process.env.BETTER_AUTH_SECRET) {
		process.env.BETTER_AUTH_SECRET =
			"local-dev-secret-not-for-production-use-32b";
	}
	if (!process.env.BETTER_AUTH_URL) {
		process.env.BETTER_AUTH_URL = "http://localhost:5173";
	}
	if (!process.env.ORIGIN) {
		process.env.ORIGIN = "http://localhost:5173";
	}
}

if (isEmbeddedDb() || isDevLoginEnabled()) {
	ensureDevAuthEnv();
}

const microsoftConfigured = Boolean(process.env.MICROSOFT_CLIENT_ID);
const devLogin = isDevLoginEnabled();

function netidFromEmail(email: string): string | null {
	const local = email.split("@")[0]?.trim();
	return local || null;
}

export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET!,
	baseURL: process.env.BETTER_AUTH_URL!,
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: { user, session, account, verification },
	}),
	emailAndPassword: devLogin
		? {
				enabled: true,
			}
		: undefined,
	session: {
		cookieCache: { enabled: true, maxAge: 300 },
	},
	user: {
		additionalFields: {
			netid: { type: "string", required: false },
			uin: { type: "string", required: false },
			displayName: { type: "string", required: false },
			entraOid: { type: "string", required: false },
		},
	},
	socialProviders: microsoftConfigured
		? {
				microsoft: {
					clientId: process.env.MICROSOFT_CLIENT_ID!,
					clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
					tenantId: process.env.MICROSOFT_TENANT_ID!,
					prompt: "select_account",
					disableProfilePhoto: true,
					mapProfileToUser: (profile) => {
						const netid = profile.preferred_username ?? profile.upn ?? null;
						const entraOid = profile.oid ?? null;
						const displayName = profile.name ?? null;
						const email = profile.email ?? profile.preferred_username;
						return { netid, entraOid, displayName, email };
					},
				},
			}
		: {},
	databaseHooks: {
		user: {
			create: {
				after: async (created) => {
					const existingNetid =
						(created as { netid?: string | null }).netid ?? null;
					const netid =
						existingNetid ??
						(devLogin ? netidFromEmail(created.email) : null);

					if (netid && !existingNetid) {
						const { eq } = await import("drizzle-orm");
						await db
							.update(user)
							.set({ netid })
							.where(eq(user.id, created.id));
					}

					await bootstrapUser({
						id: created.id,
						email: created.email,
						netid,
						displayName:
							(created as { displayName?: string | null }).displayName ??
							created.name,
					});
				},
			},
		},
	},
	advanced: {
		useSecureCookies: process.env.NODE_ENV === "production",
		ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
	},
});

export { microsoftConfigured, devLogin };
