import type { ProvisioningApiUpdateRequest } from "../types";

export interface AdSyncResult {
	ok: boolean;
	error?: string;
}

/**
 * Push identity changes to AD when the Windows API is configured.
 * Local/dev (no WINDOWS_API_URL) is a no-op success.
 */
export async function syncAdUser(
	payload: ProvisioningApiUpdateRequest,
	fetchImpl: typeof fetch = fetch,
): Promise<AdSyncResult> {
	const API_URL = process.env.WINDOWS_API_URL;
	if (!API_URL) {
		console.log(
			`[ad-sync stub] ${payload.samAccountName}` +
				(payload.username && payload.username !== payload.samAccountName
					? ` → ${payload.username}`
					: ""),
		);
		return { ok: true };
	}

	const API_TOKEN = process.env.WINDOWS_API_TOKEN;
	if (!API_TOKEN) {
		return { ok: false, error: "WINDOWS_API_TOKEN is not set." };
	}

	try {
		const res = await fetchImpl(
			`${API_URL}/users/${encodeURIComponent(payload.samAccountName)}`,
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${API_TOKEN}`,
				},
				body: JSON.stringify({
					username: payload.username,
					firstName: payload.firstName,
					lastName: payload.lastName,
					preferredName: payload.preferredName,
					displayName: payload.displayName,
					email: payload.email,
					uin: payload.uin,
				}),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (res.status === 404) {
			return {
				ok: false,
				error: "No Active Directory account was found for this username.",
			};
		}
		if (!res.ok) {
			return {
				ok: false,
				error: `Directory update failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
			};
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
