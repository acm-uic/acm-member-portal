import { z } from "zod";

export interface HealthCheckResult {
  ok: boolean;
  httpStatus: number | null;
  message: string;
  checkedAt: string;
}

export interface DirectoryLookupResult extends HealthCheckResult {
  username: string;
  exists: boolean | null;
}

/** Server-side diagnostics. Never return credentials or raw backend errors. */
async function requestStatus(
  path: string,
  authenticated: boolean,
  fetchImpl: typeof fetch,
) {
  const baseUrl = process.env.WINDOWS_API_URL?.trim();
  if (!baseUrl) throw new Error("configuration-url");
  const token = process.env.WINDOWS_API_TOKEN;
  if (authenticated && !token) throw new Error("configuration-token");
  return fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
    redirect: "error",
  });
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "configuration-url")
      return "WINDOWS_API_URL is not configured.";
    if (error.message === "configuration-token")
      return "WINDOWS_API_TOKEN is not configured.";
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "The Windows API did not respond within 10 seconds.";
  }
  return "Could not connect to the Windows API. Check the portal's network access and backend configuration.";
}

function validDirectoryUsername(username: string) {
  return (
    !!username &&
    username !== "." &&
    username !== ".." &&
    username.length <= 64 &&
    !/[\x00-\x1f\x7f/\\]/.test(username)
  );
}

const syncFailureCode = z.enum([
  "settings-unavailable",
  "module-unavailable",
  "scheduler-unavailable",
  "scheduler-suspended",
  "directory-disabled",
  "directory-busy",
  "outside-managed-ou",
  "adsync-command-failed",
  "connect-read-failed",
  "request-failed",
  "timeout",
]);
const syncTime = z.iso.datetime({ offset: true });
const syncRetry = z.object({
  id: z.uuid(),
  attempts: z.number().int().min(0).max(1000),
  nextAttempt: syncTime,
  failureCode: syncFailureCode.nullable(),
});
const entraSyncResponse = z.object({
  samAccountName: z.string(),
  account: z
    .object({
      distinguishedName: z.string().min(1).max(4096),
      userPrincipalName: z.string().max(1024).nullable(),
    })
    .nullable(),
  retries: z
    .object({
      enabled: z.boolean(),
      directory: syncRetry.nullable(),
      userHash: syncRetry.nullable(),
    })
    .nullable(),
  inspection: z
    .object({
      state: z.enum([
        "ad-not-imported",
        "source-sync-error",
        "metaverse-link-missing",
        "target-link-missing",
        "target-unavailable",
        "target-sync-error",
        "export-error",
        "target-linked",
      ]),
      targetDn: z.string().max(4096).nullable(),
      errorCode: z
        .string()
        .regex(
          /^(?:QuarantinedAttributeValueMustBeUnique|AttributeValueMustBeUnique|InvalidSoftMatch|ObjectTypeMismatch|InvalidHardMatch|InvalidAttributeValue|LargeObject|permission-issue|duplicate-attribute)$/i,
        )
        .nullable(),
      conflictAttribute: z
        .string()
        .regex(
          /^(?:proxyAddresses|userPrincipalName|onPremises?SecurityIdentifier|mail)$/i,
        )
        .nullable(),
      conflictObjectId: z.uuid().nullable(),
      conflictValue: z
        .string()
        .max(254)
        .regex(/^[a-z0-9.!#$%&*+/=?^_{|}~\-]+@[a-z0-9.\-]+\.[a-z0-9\-]+$/i)
        .nullable(),
      passwordStatus: z
        .enum([
          "Success",
          "FilteredByTarget",
          "NoTargetConnection",
          "SourceConnectorNotPresent",
          "TargetNotExportedToDirectory",
          "Error",
          "Unknown",
          "MissingAttribute",
          "RetryRequestedByTarget",
          "MigratedCheckDetailsForMoreInfo",
          "unavailable",
        ])
        .nullable(),
      passwordCheckedAt: syncTime.nullable(),
    })
    .nullable(),
  inspectionFailure: syncFailureCode.nullable(),
});

export type EntraSyncDetails = z.infer<typeof entraSyncResponse>;
export type EntraSyncLookupResult = HealthCheckResult & {
  details: EntraSyncDetails | null;
};

export async function lookupEntraSync(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EntraSyncLookupResult> {
  const username = input.trim();
  const checkedAt = new Date().toISOString();
  let httpStatus: number | null = null;
  const failure = (message: string): EntraSyncLookupResult => ({
    ok: false,
    httpStatus,
    checkedAt,
    message,
    details: null,
  });
  if (!validDirectoryUsername(username))
    return failure("Enter a valid ACM username.");

  try {
    const response = await requestStatus(
      `/users/${encodeURIComponent(username)}/entra-sync`,
      true,
      fetchImpl,
    );
    httpStatus = response.status;
    if (httpStatus === 404)
      return failure(
        "The Windows API does not have the Entra diagnostics endpoint. Check its deployment version.",
      );
    if (httpStatus === 429)
      return failure("Entra sync diagnostics are busy. Try again shortly.");
    if (httpStatus === 502)
      return failure(
        "The Windows API could not read this account from Active Directory. Check directory connectivity and service access.",
      );
    if (!response.ok)
      return failure(`Entra sync lookup failed with HTTP ${httpStatus}.`);

    const parsed = entraSyncResponse.safeParse(await response.json());
    if (!parsed.success || parsed.data.samAccountName !== username)
      return failure(
        "The Entra diagnostics endpoint returned an unexpected response.",
      );

    const details = parsed.data;
    return {
      ok: true,
      httpStatus,
      checkedAt,
      details,
      message: details.account
        ? ""
        : "This username was not found in the managed Active Directory OU.",
    };
  } catch (error) {
    return failure(
      httpStatus === null
        ? failureMessage(error)
        : "The Entra diagnostics endpoint returned an invalid response.",
    );
  }
}

export async function checkWindowsApiHealth(
  fetchImpl: typeof fetch = fetch,
): Promise<HealthCheckResult> {
  const checkedAt = new Date().toISOString();
  let httpStatus: number | null = null;
  try {
    const response = await requestStatus("/healthz", false, fetchImpl);
    httpStatus = response.status;
    if (!response.ok)
      return {
        ok: false,
        httpStatus,
        checkedAt,
        message: `Health check failed with HTTP ${httpStatus}.`,
      };
    const body = await response.json();
    if (body?.status !== "ok")
      return {
        ok: false,
        httpStatus,
        checkedAt,
        message: "The health endpoint returned an unexpected response.",
      };
    return {
      ok: true,
      httpStatus,
      checkedAt,
      message: "The Windows API is reachable and reports ok.",
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus,
      checkedAt,
      message:
        httpStatus === null
          ? failureMessage(error)
          : "The health endpoint returned an invalid response.",
    };
  }
}

export async function lookupDirectoryUser(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryLookupResult> {
  const username = input.trim();
  const result = {
    username,
    exists: null,
    httpStatus: null,
    checkedAt: new Date().toISOString(),
  };
  if (!validDirectoryUsername(username)) {
    return {
      ...result,
      ok: false,
      message:
        "Enter an ACM username of up to 64 characters, without slashes or control characters.",
    };
  }
  let httpStatus: number | null = null;
  try {
    const response = await requestStatus(
      `/users/${encodeURIComponent(username)}`,
      true,
      fetchImpl,
    );
    httpStatus = response.status;
    if (httpStatus !== 200 && httpStatus !== 404)
      return {
        ...result,
        httpStatus,
        ok: false,
        message: `Directory lookup failed with HTTP ${httpStatus}.`,
      };
    const body = await response.json();
    const exists = httpStatus === 200;
    // A proxy 404 or login page must not be reported as an absent AD account.
    if (body?.existed !== exists || body?.samAccountName !== username) {
      return {
        ...result,
        httpStatus,
        ok: false,
        message: "The directory endpoint returned an unexpected response.",
      };
    }
    return {
      ...result,
      httpStatus,
      exists,
      ok: true,
      message: exists
        ? "This user exists in Active Directory."
        : "This user was not found in Active Directory.",
    };
  } catch (error) {
    return {
      ...result,
      httpStatus,
      ok: false,
      message:
        httpStatus === null
          ? failureMessage(error)
          : "The directory endpoint returned an invalid response.",
    };
  }
}
