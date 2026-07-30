/** Retry schedule: 1m, 5m, 15m, 1h (then 1h) + up to 25% jitter. */
const SCHEDULE_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export const MAX_ATTEMPTS = 10;

export function nextDelayMs(
	attempt: number,
	jitter: () => number = Math.random,
): number {
	const base =
		SCHEDULE_MS[Math.min(Math.max(attempt, 0), SCHEDULE_MS.length - 1)];
	return base + Math.floor(jitter() * base * 0.25);
}

export function isDeadLettered(attempts: number): boolean {
	return attempts >= MAX_ATTEMPTS;
}
