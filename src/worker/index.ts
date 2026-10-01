/**
 * Worker entrypoint — runs in its own k8s Deployment via
 * `node src/worker/index.ts provision` and in a nightly CronJob via
 * `node src/worker/index.ts alumni` (Node 24+ type-stripping). All local
 * imports in this graph use relative paths with explicit .ts extensions,
 * including index.ts for directories, so Node can resolve them without Vite.
 */
import { drainOnce } from "./provisioning.ts";

const MODE = process.argv[2] ?? "provision";

if (MODE === "alumni") {
	const { runAlumniDigest } = await import("./alumni-cron.ts");
	await runAlumniDigest();
	process.exit(0);
}

if (MODE !== "provision") {
	console.error(`Unknown worker mode: ${MODE}`);
	process.exit(1);
}

console.log("provisioning worker started");
const IDLE_BACKOFF_MS = 5_000;

for (;;) {
	const didWork = await drainOnce().catch((err: unknown) => {
		console.error("drain error", err);
		return false;
	});
	if (!didWork)
		await new Promise((resolve) => setTimeout(resolve, IDLE_BACKOFF_MS));
}
