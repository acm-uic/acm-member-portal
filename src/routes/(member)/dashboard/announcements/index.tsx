import { component$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { and, desc, eq } from "drizzle-orm";
import { db } from "~/lib/db";
import { contentItems, user } from "~/lib/db/schema";
import { requirePermission } from "~/lib/rbac/guards";

export const useAnnouncements = routeLoader$(async (event) => {
	await requirePermission(event, "content.read");
	const rows = await db
		.select({
			id: contentItems.id,
			title: contentItems.title,
			body: contentItems.body,
			publishedAt: contentItems.publishedAt,
			authorName: user.name,
		})
		.from(contentItems)
		.leftJoin(user, eq(contentItems.authorId, user.id))
		.where(
			and(
				eq(contentItems.status, "published"),
				eq(contentItems.type, "announcement"),
			),
		)
		.orderBy(desc(contentItems.publishedAt))
		.limit(50);
	return rows;
});

export default component$(() => {
	const announcements = useAnnouncements();

	return (
		<main class="p-xl grid gap-lg max-w-3xl">
			<header>
				<h1 class="font-display text-heading m-0">Announcements</h1>
				<p class="text-text2 text-body m-0">News from the chapter board.</p>
			</header>

			{announcements.value.length === 0 ? (
				<p class="text-text3 text-body">
					No announcements yet — check back soon.
				</p>
			) : (
				announcements.value.map((a) => (
					<article
						key={a.id}
						class="bg-surface1 border border-border rounded-component p-md grid gap-sm"
					>
						<header class="flex items-baseline justify-between gap-md">
							<h2 class="m-0 text-subheading">{a.title}</h2>
							<span class="text-caption text-text3 shrink-0">
								{a.publishedAt
									? new Date(a.publishedAt).toLocaleDateString()
									: ""}
							</span>
						</header>
						{a.body && (
							<p class="m-0 text-body text-text1 whitespace-pre-wrap">
								{a.body}
							</p>
						)}
						{a.authorName && (
							<span class="text-caption text-text3">— {a.authorName}</span>
						)}
					</article>
				))
			)}
		</main>
	);
});
