/** Keep credentials out of persisted diagnostics and pod logs. */
export function sanitizeProvisioningError(
  error: string,
  secrets: Array<string | undefined> = [],
): string {
  let result = error;
  for (const secret of [
    ...secrets,
    process.env.WINDOWS_API_TOKEN,
    process.env.SMTP_PASS,
    process.env.SMTP_PASSWORD,
    process.env.BETTER_AUTH_SECRET,
    process.env.DATABASE_URL,
  ]) {
    if (secret) {
      const jsonEscapedSecret = JSON.stringify(secret).slice(1, -1);
      result = result
        .replaceAll(jsonEscapedSecret, "[redacted]")
        .replaceAll(secret, "[redacted]");
    }
  }
  return result
    .replace(/Bearer\s+[^\s"'\\,}]+/gi, "Bearer [redacted]")
    .replace(
      /("(?:oneTimePassword|password|token|authorization|clientSecret)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|\\?$)/gi,
      '$1"[redacted]"',
    )
    .replace(
      /\b(password|token|clientSecret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\0|\\u0000/g, "")
    .slice(0, 2000)
    .trim();
}
