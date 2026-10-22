import { sendMail } from "./smtp.ts";
import { credentialDeliveryInstructions } from "../credential-instructions.ts";

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
		subject: "Activate your ACM@UIC account",
		text: [
			`Hi,`,
			``,
			`Your ACM@UIC membership has been approved and your AD account has been created. Activate it before signing in with Microsoft.`,
			``,
			credentialDeliveryInstructions({
				username: args.username,
				oneTimePassword: args.oneTimePassword,
				publicOrigin: process.env.ORIGIN || process.env.BETTER_AUTH_URL,
			}),
			``,
			`— ACM@UIC`,
		].join("\n"),
	});
}
