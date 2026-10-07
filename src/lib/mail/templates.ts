import { sendMail } from "./smtp.ts";

/**
 * Initial AD credentials. The one-time password transits portal → mailbox
 * without being logged or persisted in production. A failed delivery can
 * retry with a newly issued temporary password.
 */
export async function sendCredentialEmail(args: {
	to: string;
	username: string;
	oneTimePassword: string;
}): Promise<void> {
	await sendMail({
		to: args.to,
		subject: "Your ACM@UIC account is ready",
		text: [
			`Hi,`,
			``,
			`Your ACM@UIC membership has been approved and your account is ready.`,
			``,
			`  Username: ${args.username}`,
			`  One-time password: ${args.oneTimePassword}`,
			``,
			`Sign in at https://portal.acm-uic.org with "Sign in with Microsoft".`,
			`You will be required to change this password at first sign-in.`,
			``,
			`— ACM@UIC`,
		].join("\n"),
	});
}
