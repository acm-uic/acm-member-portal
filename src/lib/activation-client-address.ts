import { isIP } from "node:net";

type ActivationConnection = {
  platform?: {
    incomingMessage?: { socket?: { remoteAddress?: string } };
  };
  clientConn?: { ip?: string };
  request?: Request;
};

/**
 * Use the adapter's socket address, never caller-supplied forwarding headers.
 * Qwik's Node adapter derives clientConn.ip from the socket too. Behind an
 * ingress, requests share that proxy's rate-limit budget; missing connection
 * information shares a conservative fallback bucket instead of bypassing it.
 */
export function trustedActivationClientAddress(
  event: ActivationConnection,
): string {
  const address =
    event.platform?.incomingMessage?.socket?.remoteAddress ??
    event.clientConn?.ip;
  if (!address || !isIP(address)) return "unknown";
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4) {
    return normalized.slice(7);
  }
  return normalized;
}
