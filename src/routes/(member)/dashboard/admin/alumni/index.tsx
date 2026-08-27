import { component$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import {
	computeAlumniCandidates,
	transitionToAlumni,
} from "~/lib/alumni/suggestions";
import { requirePermission } from "~/lib/rbac/guards";

export const useAlumniCandidates = routeLoader$(async (event) => {
	await requirePermission(event, "alumni.review");
	return computeAlumniCandidates();
});

export const useApproveAlumni = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "alumni.approve");
	const userId = String(data.userId ?? "");
	if (!userId) return { ok: false as const, error: "Missing user." };
	await transitionToAlumni(userId, session.user.id);
	return { ok: true as const };
});

export default component$(() => {
	const candidates = useAlumniCandidates();
	const approve = useApproveAlumni();

	return (
		<main class="p-xl grid gap-lg max-w-3xl">
			<header>
				<h1 class="font-display text-heading m-0">Alumni transitions</h1>
				<p class="text-text2 text-body m-0">
					Active members whose expected graduation year has passed. Approving
					moves them from the member role to the alumni role.
				</p>
			</header>

			{candidates.value.length === 0 ? (
				<p class="text-text3 text-body">
					Nobody is eligible right now. Officers get an email digest when
					someone is.
				</p>
			) : (
				<table class="w-full border-collapse text-body-sm">
					<thead>
						<tr class="text-left text-text3 text-caption">
							<th class="py-sm border-t border-border">Name</th>
							<th class="py-sm border-t border-border">NetID</th>
							<th class="py-sm border-t border-border">Class of</th>
							<th class="py-sm border-t border-border">Action</th>
						</tr>
					</thead>
					<tbody>
						{candidates.value.map((c) => (
							<tr key={c.userId}>
								<td class="py-sm border-t border-border text-text1">
									{c.name}
								</td>
								<td class="py-sm border-t border-border font-mono text-text3">
									{c.netid ?? "—"}
								</td>
								<td class="py-sm border-t border-border text-text1">
									{c.gradYear}
								</td>
								<td class="py-sm border-t border-border">
									<button
										type="button"
										class="px-sm py-2xs rounded-control bg-accent text-white text-label cursor-pointer"
										onClick$={async () => {
											await approve.submit({ userId: c.userId });
										}}
									>
										Move to alumni
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</main>
	);
});
