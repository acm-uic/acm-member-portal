type MicrosoftProfile = {
  preferred_username?: string;
  upn?: string;
  oid?: string;
  name?: string;
  email?: string;
};

export function mapMicrosoftProfileToUser(profile: MicrosoftProfile) {
  const identifier = profile.preferred_username ?? profile.upn;
  const netid = identifier?.split("@")[0]?.trim() || null;

  return {
    netid,
    entraOid: profile.oid ?? null,
    displayName: profile.name ?? null,
    email: profile.email ?? profile.preferred_username,
  };
}
