const CANONICAL_PORTAL_ORIGIN = "https://portal.acmuic.org";

/** Safe to use in both server mail rendering and the manual-delivery UI. */
export function accountOnboardingUrls(publicOrigin?: string) {
  let origin = CANONICAL_PORTAL_ORIGIN;
  if (publicOrigin?.trim()) {
    try {
      const configured = new URL(publicOrigin.trim());
      if (configured.protocol === "https:" || configured.protocol === "http:") {
        origin = configured.origin;
      }
    } catch {
      // A missing or malformed public origin must not produce broken links.
    }
  }
  return {
    activation: `${origin}/activate/`,
    login: `${origin}/login/`,
  };
}

/** Contains credentials: only send to the applicant; never log or persist it. */
export function credentialDeliveryInstructions(args: {
  username: string;
  oneTimePassword: string;
  publicOrigin?: string;
}): string {
  const urls = accountOnboardingUrls(args.publicOrigin);
  return [
    `Username: ${args.username}`,
    `Temporary password: ${args.oneTimePassword}`,
    "",
    `1. Activate your account at ${urls.activation}`,
    "   Enter your username and temporary password, then choose a new password.",
    "2. Allow up to 30 minutes for your new password to synchronize with Microsoft.",
    `3. Visit ${urls.login} and choose \"Sign in with Microsoft\" using your ACM email address and new password.`,
    "",
    "Use the temporary password only on the activation page. Keep these credentials private.",
  ].join("\n");
}
