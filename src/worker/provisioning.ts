import {
	claimNext,
	markCredentialDelivery,
	markFailed,
	markProvisioned,
} from "../lib/provisioning/outbox.ts";
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
			event.id,
			"Exceeded max attempts (crash-loop reaper)",
			event.attempts,
		);
		return true;
	}

	try {
		if (event.credentialDeliveryStatus === "delivered") {
			await markProvisioned(event.id);
			return true;
		}

		const { payload, username, body } = await provisionAccount(
			event,
			fetchImpl,
		);

		if (!body.oneTimePassword && event.credentialDeliveryStatus === "pending") {
			throw new Error(
				"AD account exists, but its credential email has not been delivered. " +
					"The provisioning API could not reissue this signup's temporary credentials. " +
					"An administrator must verify the account and credential delivery before retrying.",
			);
		}

		if (body.oneTimePassword) {
			await markCredentialDelivery(event.id, "pending");
			// Local-only: create an email/password user so the applicant can
			// sign in without Entra (password = one-time password from mail stub).
			if (!process.env.WINDOWS_API_URL) {
				await seedLocalMemberLogin({
					email: payload.email,
					name: payload.displayName,
					password: body.oneTimePassword,
					netid: payload.netid,
					username,
					uin: payload.uin,
					firstName: payload.firstName,
					lastName: payload.lastName,
					preferredName: payload.preferredName,
					reissue: true,
				});
			}
			await sendCredentialEmail({
				to: payload.email,
				username: body.samAccountName,
				oneTimePassword: body.oneTimePassword,
			});
			await markCredentialDelivery(event.id, "delivered");
		}

		await markProvisioned(event.id);
	} catch (err) {
		await markFailed(
			event.id,
			err instanceof Error ? err.message : String(err),
			event.attempts + 1,
		);
	}

	return true;
}
