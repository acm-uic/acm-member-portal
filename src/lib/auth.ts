import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "~/lib/db";
import { account, session, user, verification } from "~/lib/db/schema";
import { bootstrapUser } from "~/lib/auth-bootstrap";

export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET!,
	baseURL: process.env.BETTER_AUTH_URL!,
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: { user, session, account, verification },
	}),
	session: {
		// Avoids per-request session-refresh DB writes from plugin@auth (research: session mgmt docs)
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
	socialProviders: {
		microsoft: {
			clientId: process.env.MICROSOFT_CLIENT_ID!,
			clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
			// Single-tenant lock: iss/tid validated against this tenant (verified from provider source)
			tenantId: process.env.MICROSOFT_TENANT_ID!,
			prompt: "select_account",
			// Graph photo is inlined as base64 and can exceed header limits (provider docs warning)
			disableProfilePhoto: true,
			mapProfileToUser: (profile) => {
				const netid = profile.preferred_username ?? profile.upn ?? null;
				const entraOid = profile.oid ?? null;
				const displayName = profile.name ?? null;
				// Entra does not emit `email` for managed users by default — fallback required
				const email = profile.email ?? profile.preferred_username;
				return { netid, entraOid, displayName, email };
			},
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (created) => {
					await bootstrapUser({
						id: created.id,
						email: created.email,
						netid: (created as { netid?: string | null }).netid ?? null,
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
