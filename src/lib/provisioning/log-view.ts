export const PROVISIONING_STATUSES = [
  "pending",
  "processing",
  "failed",
  "dead_lettered",
  "provisioned",
] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];
export const STATUS_LABELS: Record<ProvisioningStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  failed: "Failed",
  dead_lettered: "Retries stopped",
  provisioned: "Completed",
};

/** Fixed zone makes server rendering and browser navigation agree. */
export function formatProvisioningTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function provisioningPageHref(input: {
  q?: string;
  status?: string;
  page?: number;
  event?: string;
  logPage?: number;
}) {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.status) params.set("status", input.status);
  if (input.page && input.page > 1) params.set("page", String(input.page));
  if (input.event) params.set("event", input.event);
  if (input.logPage && input.logPage > 1)
    params.set("logPage", String(input.logPage));
  const query = params.toString();
  return `/dashboard/admin/provisioning/${query ? `?${query}` : ""}`;
}
