import type { RequestEventCommon } from "@builder.io/qwik-city";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  provisioningEvents,
  provisioningLogs,
  signupSubmissions,
} from "../db/schema";
import { requirePermission } from "../rbac/guards";
import { formatSignupDisplayName } from "../forms/fields";
import { provisioningErrorText } from "../signups/queue";
import { sanitizeProvisioningError } from "./diagnostics";
import { PROVISIONING_STATUSES, type ProvisioningStatus } from "./log-view";

const PAGE_SIZE = 25;
const LOG_PAGE_SIZE = 50;
const eventFields = {
  id: provisioningEvents.id,
  firstName: signupSubmissions.firstName,
  lastName: signupSubmissions.lastName,
  preferredName: signupSubmissions.preferredName,
  netid: signupSubmissions.netid,
  username: sql<string>`coalesce(${provisioningEvents.payload}->>'username', ${signupSubmissions.username}, ${signupSubmissions.netid})`,
  status: provisioningEvents.status,
  signupStatus: signupSubmissions.status,
  attempts: provisioningEvents.attempts,
  deliveryMode: provisioningEvents.credentialDeliveryMode,
  deliveryStatus: provisioningEvents.credentialDeliveryStatus,
  lastError: provisioningEvents.lastError,
  createdAt: provisioningEvents.createdAt,
  updatedAt: provisioningEvents.updatedAt,
  nextAttemptAt: provisioningEvents.nextAttemptAt,
};

function diagnostic(error: string | null) {
  if (!error) return null;
  const safe = sanitizeProvisioningError(error);
  const prefix = /^Provisioning API \d+: /.exec(safe)?.[0] ?? "";
  const message = provisioningErrorText(safe);
  return prefix && message !== safe ? prefix + message : message;
}

function pageNumber(input: string | null) {
  const value = Number(input ?? 1);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000
    ? value
    : 1;
}

export async function requireProvisioningLogAccess(event: RequestEventCommon) {
  await requirePermission(event, "admin.access");
  await requirePermission(event, "signups.review");
}

/** Explicit projection excludes passwords, account payloads, UINs, and claim tokens. */
export async function readProvisioningPage(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const statusInput = url.searchParams.get("status");
  const status: ProvisioningStatus | "" = PROVISIONING_STATUSES.includes(
    statusInput as ProvisioningStatus,
  )
    ? (statusInput as ProvisioningStatus)
    : "";
  const page = pageNumber(url.searchParams.get("page"));
  const logPage = pageNumber(url.searchParams.get("logPage"));
  const filters: SQL[] = [];
  if (status) filters.push(eq(provisioningEvents.status, status));
  if (q) {
    // Treat search characters literally instead of letting '%' match every applicant.
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(
      or(
        ilike(signupSubmissions.netid, pattern),
        ilike(signupSubmissions.username, pattern),
        ilike(signupSubmissions.firstName, pattern),
        ilike(signupSubmissions.lastName, pattern),
        ilike(signupSubmissions.preferredName, pattern),
        ilike(
          sql`concat_ws(' ', ${signupSubmissions.firstName}, ${signupSubmissions.lastName})`,
          pattern,
        ),
        ilike(
          sql`coalesce(${provisioningEvents.payload}->>'username', ${signupSubmissions.username})`,
          pattern,
        ),
      )!,
    );
  }
  function events() {
    return db
      .select(eventFields)
      .from(provisioningEvents)
      .innerJoin(
        signupSubmissions,
        eq(provisioningEvents.submissionId, signupSubmissions.id),
      );
  }
  function serialize(row: {
    id: string;
    firstName: string;
    lastName: string;
    preferredName: string | null;
    netid: string;
    username: string;
    status: ProvisioningStatus;
    signupStatus: string;
    attempts: number;
    deliveryMode: "email" | "admin";
    deliveryStatus: "pending" | "delivered" | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
    nextAttemptAt: Date;
  }) {
    return {
      id: row.id,
      displayName: formatSignupDisplayName(row),
      netid: row.netid,
      username: row.username || row.netid,
      status: row.status,
      signupStatus: row.signupStatus,
      attempts: row.attempts,
      deliveryMode: row.deliveryMode,
      deliveryStatus: row.deliveryStatus,
      lastError: diagnostic(row.lastError),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      nextAttemptAt:
        row.deliveryMode === "email" &&
        ["pending", "failed"].includes(row.status)
          ? row.nextAttemptAt.toISOString()
          : null,
    };
  }
  const selectedInput = url.searchParams.get("event");
  const selectedId = z.uuid().safeParse(selectedInput);
  const [selectedRow] = selectedId.success
    ? await events().where(eq(provisioningEvents.id, selectedId.data)).limit(1)
    : [];
  const rows = selectedInput
    ? []
    : await events()
        .where(and(...filters))
        .orderBy(
          desc(provisioningEvents.updatedAt),
          desc(provisioningEvents.id),
        )
        .limit(PAGE_SIZE + 1)
        .offset((page - 1) * PAGE_SIZE);
  const history = selectedRow
    ? await db
        .select({
          id: provisioningLogs.id,
          kind: provisioningLogs.kind,
          attempt: provisioningLogs.attempt,
          message: provisioningLogs.message,
          error: provisioningLogs.error,
          createdAt: provisioningLogs.createdAt,
        })
        .from(provisioningLogs)
        .where(eq(provisioningLogs.eventId, selectedRow.id))
        .orderBy(desc(provisioningLogs.createdAt), desc(provisioningLogs.id))
        .limit(LOG_PAGE_SIZE + 1)
        .offset((logPage - 1) * LOG_PAGE_SIZE)
    : [];
  return {
    checkedAt: new Date().toISOString(),
    q,
    status,
    page,
    logPage,
    hasNext: rows.length > PAGE_SIZE,
    hasOlderLogs: history.length > LOG_PAGE_SIZE,
    rows: rows.slice(0, PAGE_SIZE).map(serialize),
    selected: selectedRow ? serialize(selectedRow) : null,
    selectedRequested: !!selectedInput,
    logs: history.slice(0, LOG_PAGE_SIZE).map((entry) => ({
      ...entry,
      error: diagnostic(entry.error),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export async function loadProvisioningPage(event: RequestEventCommon) {
  await requireProvisioningLogAccess(event);
  return readProvisioningPage(event.url);
}
