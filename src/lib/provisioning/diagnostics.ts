function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonSecretPattern(secret: string) {
  return Array.from({ length: secret.length }, (_, index) => {
    const codeUnit = secret.charCodeAt(index);
    const encoded = JSON.stringify(secret[index]).slice(1, -1);
    const hex = codeUnit
      .toString(16)
      .padStart(4, "0")
      .replace(/[a-f]/g, (character) =>
        `[${character}${character.toUpperCase()}]`,
      );
    const alternatives = [escapeRegex(encoded), `\\\\u${hex}`];
    if (secret[index] === "/") alternatives.push("\\\\/");
    return `(?:${alternatives.join("|")})`;
  }).join("");
}

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
      result = result
        .replace(new RegExp(jsonSecretPattern(secret), "g"), "[redacted]")
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
