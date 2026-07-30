import nodemailer from "nodemailer";

/** Org self-hosted SMTP; credentials from the k8s Secret via env. */
const transport = nodemailer.createTransport({
	host: process.env.SMTP_HOST,
	port: Number(process.env.SMTP_PORT ?? 587),
	secure: Number(process.env.SMTP_PORT ?? 587) === 465,
	auth: process.env.SMTP_USER
		? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
		: undefined,
});

export async function sendMail(message: {
	to: string;
	subject: string;
	text: string;
}): Promise<void> {
	await transport.sendMail({ from: process.env.SMTP_FROM, ...message });
}
