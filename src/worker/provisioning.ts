import {
	claimNext,
	markCredentialDelivery,
	markFailed,
	markProvisioned,
	withProvisioningClaim,
} from "../lib/provisioning/outbox.ts";
import { sanitizeProvisioningError } from "../lib/provisioning/diagnostics.ts";
import { MAX_ATTEMPTS } from "../lib/provisioning/backoff.ts";
import { sendCredentialEmail } from "../lib/mail/templates.ts";
import {
	provisionAccount,
	seedLocalMemberLogin,
} from "../lib/provisioning/account.ts";

/**
 * Drain one provisioning event. Returns false when the queue is empty
 * (caller backs off). Undelivered credentials can be reissued only for an
 * account owned by this event. Delivery receipts survive worker restarts;
 * temporary passwords are never persisted.
 *
 * When WINDOWS_API_URL is unset, stubs AD creation locally (dev / PGlite).
 */
export async function drainOnce(
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const event = await claimNext();
	if (!event) return false;

	// Crash-loop guard: a repeatedly reclaimed event exhausts its attempts
	// without ever reaching markFailed — dead-letter it instead of re-POSTing.
	if (
		event.attempts >= MAX_ATTEMPTS &&
		event.credentialDeliveryStatus !== "delivered"
	) {
		await markFailed(
			event,
			"Exceeded max attempts (crash-loop reaper)",
			event.attempts,
		);
		return true;
	}

	let issuedPassword: string | undefined;
	try {
		if (event.credentialDeliveryStatus === "delivered") {
			await markProvisioned(event);
			return true;
		}

		const provisioned = await withProvisioningClaim(event, async (tx) => {
			const result = await provisionAccount(event, fetchImpl);
			issuedPassword = result.body.oneTimePassword;
			if (
				!result.body.oneTimePassword &&
				event.credentialDeliveryStatus === "pending"
			) {
				throw new Error(
					"AD account exists, but its credential email has not been delivered. " +
						"The provisioning API could not reissue this signup's temporary credentials. " +
						"An administrator must verify the account and credential delivery before retrying.",
				);
			}
			if (result.body.oneTimePassword) {
				await markCredentialDelivery(event, "pending", tx);
			}
			return result;
		});
		if (!provisioned.owned) return true;
		const { payload, username, body } = provisioned.value;
		const password = body.oneTimePassword;
		if (password) {
			const localLogin = {
				email: payload.email,
				name: payload.displayName,
				password,
				netid: payload.netid,
				username,
				uin: payload.uin,
				firstName: payload.firstName,
				lastName: payload.lastName,
				preferredName: payload.preferredName,
			};
			// Create a missing local user outside the transaction. Existing hashes
			// are only reissued below, while this claim owns the delivery lock.
			if (!process.env.WINDOWS_API_URL) await seedLocalMemberLogin(localLogin);
			const delivered = await withProvisioningClaim(event, async (tx) => {
				if (!process.env.WINDOWS_API_URL) {
					await seedLocalMemberLogin({ ...localLogin, reissue: true }, tx);
				}
				await sendCredentialEmail({
					to: payload.email,
					username: body.samAccountName,
					oneTimePassword: password,
				});
				await markCredentialDelivery(event, "delivered", tx);
			});
			if (!delivered.owned) return true;
		}
		// The receipt commits before completion so a failed completion can retry
		// without resetting the account or sending another email.
		await markProvisioned(event);
	} catch (err) {
		await markFailed(
			event,
			sanitizeProvisioningError(
				err instanceof Error ? err.message : String(err),
				[issuedPassword],
			),
			event.attempts + 1,
		);
	}

	return true;
}
