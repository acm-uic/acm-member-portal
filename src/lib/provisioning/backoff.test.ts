import { describe, expect, it } from "vitest";
import { isDeadLettered, MAX_ATTEMPTS, nextDelayMs } from "./backoff";

describe("nextDelayMs", () => {
	it("follows the 1m/5m/15m/1h schedule with zero jitter", () => {
		const zero = () => 0;
		expect(nextDelayMs(0, zero)).toBe(60_000);
		expect(nextDelayMs(1, zero)).toBe(300_000);
		expect(nextDelayMs(2, zero)).toBe(900_000);
		expect(nextDelayMs(3, zero)).toBe(3_600_000);
	});

	it("caps the base at 1h for attempts beyond the schedule", () => {
		expect(nextDelayMs(9, () => 0)).toBe(3_600_000);
		expect(nextDelayMs(100, () => 0)).toBe(3_600_000);
	});

	it("adds up to 25% jitter", () => {
		expect(nextDelayMs(0, () => 0.999)).toBeLessThanOrEqual(60_000 + 15_000);
		expect(nextDelayMs(0, () => 0.999)).toBeGreaterThan(60_000);
	});

	it("clamps negative attempts to the first step", () => {
		expect(nextDelayMs(-5, () => 0)).toBe(60_000);
	});
});

describe("isDeadLettered", () => {
	it("is false below MAX_ATTEMPTS and true at/above it", () => {
		expect(isDeadLettered(MAX_ATTEMPTS - 1)).toBe(false);
		expect(isDeadLettered(MAX_ATTEMPTS)).toBe(true);
		expect(isDeadLettered(MAX_ATTEMPTS + 5)).toBe(true);
	});
});
