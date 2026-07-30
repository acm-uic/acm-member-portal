import { component$ } from "@builder.io/qwik";
import type { ContentType } from "~/lib/types";

const TYPE_OPTIONS: Array<{ value: ContentType; label: string }> = [
	{ value: "announcement", label: "Announcement" },
	{ value: "document", label: "Document" },
	{ value: "meeting_note", label: "Meeting note" },
];

/** Create/edit form for hosted content. Plain-text body (no markdown in v1). */
export const ContentForm = component$<{ error?: string }>(({ error }) => (
	<div class="grid gap-md">
		<div class="grid gap-xs">
			<label for="title" class="text-label text-text2">
				Title
			</label>
			<input
				id="title"
				name="title"
				type="text"
				required
				maxLength={200}
				class="px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
			/>
		</div>

		<div class="grid gap-xs max-w-xs">
			<label for="type" class="text-label text-text2">
				Type
			</label>
			<select
				id="type"
				name="type"
				class="px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
			>
				{TYPE_OPTIONS.map((t) => (
					<option key={t.value} value={t.value}>
						{t.label}
					</option>
				))}
			</select>
		</div>

		<div class="grid gap-xs">
			<label for="body" class="text-label text-text2">
				Body
			</label>
			<textarea
				id="body"
				name="body"
				rows={10}
				placeholder="Plain text. Links are fine — they render as text."
				class="px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
			/>
		</div>

		<div class="grid gap-xs max-w-xs">
			<label for="status" class="text-label text-text2">
				Publish state
			</label>
			<select
				id="status"
				name="status"
				class="px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
			>
				<option value="draft">Save as draft</option>
				<option value="published">Publish now</option>
			</select>
		</div>

		{error && (
			<p role="alert" class="text-caption text-error m-0">
				{error}
			</p>
		)}
	</div>
));
