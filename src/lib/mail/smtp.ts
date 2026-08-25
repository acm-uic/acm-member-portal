import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

function mailDir(): string {
	return process.env.MAIL_DIR ?? ".data/mail";
}

let transport: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null =
	null;

function getTransport() {
	if (!process.env.SMTP_HOST) return null;
	if (!transport) {
		transport = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT ?? 587),
			secure: Number(process.env.SMTP_PORT ?? 587) === 465,
			auth: process.env.SMTP_USER
				? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
				: undefined,
		});
	}
	return transport;
}

export async function sendMail(message: {
	to: string;
	subject: string;
	text: string;
}): Promise<void> {
	const t = getTransport();
	if (!t) {
		const dir = mailDir();
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(dir, `${stamp}.txt`);
		const body = [
			`To: ${message.to}`,
			`Subject: ${message.subject}`,
			``,
			message.text,
			``,
		].join("\n");
		writeFileSync(path, body, "utf8");
		console.log(`[mail stub] wrote ${path}`);
		console.log(body);
		return;
	}

	await t.sendMail({ from: process.env.SMTP_FROM, ...message });
}
