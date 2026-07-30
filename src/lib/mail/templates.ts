import { sendMail } from "./smtp";

/**
 * Initial AD credentials. The one-time password transits portal → mailbox
 * exactly once; it is never logged or persisted (research decision).
 */
export async function sendCredentialEmail(args: {
	to: string;
	netid: string;
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
			`  Username: ${args.netid}`,
			`  One-time password: ${args.oneTimePassword}`,
			``,
			`Sign in at https://portal.acm-uic.org with "Sign in with Microsoft".`,
			`You will be required to change this password at first sign-in.`,
			``,
			`— ACM@UIC`,
		].join("\n"),
	});
}
