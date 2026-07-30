import { component$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { desc, eq } from "drizzle-orm";
import { ContentForm } from "~/components/content/content-form";
import { db } from "~/lib/db";
import { auditEvents, contentItems } from "~/lib/db/schema";
import { requirePermission } from "~/lib/rbac/guards";
import type { ContentStatus, ContentType } from "~/lib/types";

const CONTENT_TYPES: ContentType[] = [
	"announcement",
	"document",
	"meeting_note",
];
const PUBLISH_STATES: ContentStatus[] = ["draft", "published"];

export const useContentItems = routeLoader$(async (event) => {
	await requirePermission(event, "content.publish");
	return db
		.select({
			id: contentItems.id,
			type: contentItems.type,
			title: contentItems.title,
			status: contentItems.status,
			publishedAt: contentItems.publishedAt,
			createdAt: contentItems.createdAt,
		})
		.from(contentItems)
		.orderBy(desc(contentItems.createdAt))
		.limit(50);
});

export const useCreateContent = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "content.publish");
	const title = String(data.title ?? "")
		.trim()
		.slice(0, 200);
	const type = String(data.type ?? "") as ContentType;
	const body = String(data.body ?? "").slice(0, 20_000) || null;
	const status = String(data.status ?? "draft") as ContentStatus;

	if (!title) return { ok: false as const, error: "Title is required." };
	if (!CONTENT_TYPES.includes(type))
		return { ok: false as const, error: "Unknown content type." };
	if (!PUBLISH_STATES.includes(status))
		return { ok: false as const, error: "Unknown publish state." };

	await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(contentItems)
			.values({
				type,
				title,
				body,
				status,
				authorId: session.user.id,
				publishedAt: status === "published" ? new Date() : null,
			})
			.returning({ id: contentItems.id });
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: status === "published" ? "content.publish" : "content.draft",
			targetType: "content_item",
			targetId: row.id,
			after: { type, title },
		});
	});

	return { ok: true as const };
});

export const useArchiveContent = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "content.manage");
	const id = String(data.id ?? "");

	await db.transaction(async (tx) => {
		await tx
			.update(contentItems)
			.set({ status: "archived", updatedAt: new Date() })
			.where(eq(contentItems.id, id));
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: "content.archive",
			targetType: "content_item",
			targetId: id,
		});
	});

	return { ok: true as const };
});

export default component$(() => {
	const items = useContentItems();
	const create = useCreateContent();
	const archive = useArchiveContent();

	return (
		<main class="p-xl grid gap-xl max-w-4xl">
			<header>
				<h1 class="font-display text-heading m-0">Content</h1>
				<p class="text-text2 text-body m-0">
					Announcements, documents, and meeting notes. Publishing requires
					content.publish; archiving requires content.manage.
				</p>
			</header>

			<section class="grid gap-md">
				<h2 class="text-subheading m-0">New content</h2>
				<form
					preventdefault:submit
					onSubmit$={async (e) => {
						const form = e.target as HTMLFormElement;
						await create.submit(new FormData(form));
						if (create.value?.ok) form.reset();
					}}
					class="grid gap-md"
				>
					<ContentForm
						error={create.value?.ok === false ? create.value.error : undefined}
					/>
					<button
						type="submit"
						class="w-fit px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Save
					</button>
				</form>
			</section>

			<section class="grid gap-sm">
				<h2 class="text-subheading m-0">Recent</h2>
				{items.value.length === 0 ? (
					<p class="text-text3 text-body">Nothing published yet.</p>
				) : (
					items.value.map((item) => (
						<div
							key={item.id}
							class="flex items-center justify-between gap-md bg-surface1 border border-border rounded-component p-md"
						>
							<div class="text-body-sm min-w-0">
								<span class="text-text1">{item.title}</span>
								<span class="ml-sm font-mono text-caption text-text3">
									{item.type}
								</span>
								<span
									class={`ml-sm px-sm py-2xs rounded-element text-caption font-semibold ${
										item.status === "published"
											? "bg-success-bg text-success"
											: item.status === "draft"
												? "bg-warning-bg text-warning"
												: "bg-surface3 text-text3"
									}`}
								>
									{item.status}
								</span>
							</div>
							{item.status !== "archived" && (
								<button
									type="button"
									class="shrink-0 px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer"
									onClick$={async () => {
										await archive.submit({ id: item.id });
									}}
								>
									Archive
								</button>
							)}
						</div>
					))
				)}
			</section>
		</main>
	);
});
