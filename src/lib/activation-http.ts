import { activationRejected } from "./activation-response";
import { USERNAME_MAX_LENGTH, USERNAME_PATTERN } from "./forms/fields";
import {
  type ActivationInput,
  type ActivationServerResult,
} from "./provisioning/activate-account";

const MAX_BODY_BYTES = 8192;
type Activate = (
  input: ActivationInput,
  address: string,
) => Promise<ActivationServerResult>;

export async function handleActivationRequest(
  request: Request,
  origin: string,
  address: string,
  activate: Activate,
): Promise<ActivationServerResult> {
  if (request.headers.get("origin") !== origin)
    return { ok: false, status: 403, error: activationRejected };
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    return { ok: false, status: 415, error: activationRejected };
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_BODY_BYTES)
    return { ok: false, status: 413, error: activationRejected };
  let data: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: activationRejected };
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400, error: activationRejected };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, status: 400, error: activationRejected };
  const d = data as Record<string, unknown>;
  const username =
    typeof d.username === "string" ? d.username.trim().toLowerCase() : "";
  if (
    !username ||
    username.length > USERNAME_MAX_LENGTH ||
    !USERNAME_PATTERN.test(username) ||
    typeof d.currentPassword !== "string" ||
    !d.currentPassword ||
    d.currentPassword.length > 256 ||
    typeof d.newPassword !== "string" ||
    !d.newPassword ||
    d.newPassword.length > 256 ||
    d.confirmPassword !== d.newPassword ||
    d.currentPassword === d.newPassword
  ) {
    return { ok: false, status: 400, error: activationRejected };
  }
  return activate(
    {
      username,
      currentPassword: d.currentPassword,
      newPassword: d.newPassword,
      confirmPassword: d.newPassword,
    },
    address,
  );
}
