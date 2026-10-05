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
  if (
    !username ||
    username === "." ||
    username === ".." ||
    username.length > 64 ||
    /[\x00-\x1f\x7f/\\]/.test(username)
  ) {
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
