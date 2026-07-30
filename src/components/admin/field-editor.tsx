import { $, component$, useSignal } from "@builder.io/qwik";
import type { FormFieldDef, FormFieldType } from "~/lib/types";

const FIELD_TYPES: FormFieldType[] = [
	"text",
	"email",
	"number",
	"select",
	"multiselect",
	"checkbox",
	"textarea",
];

/** Options are edited one per line as `value|Label`; serialized back on change. */
function optionsToText(f: FormFieldDef): string {
	return (f.options ?? []).map((o) => `${o.value}|${o.label}`).join("\n");
}
function textToOptions(text: string) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [value, ...rest] = line.split("|");
			return { value: value.trim(), label: (rest.join("|") || value).trim() };
		});
}

/** Client-side editor for the dynamic field list; emits JSON via a hidden input. */
export const FieldEditor = component$<{ initialFields: FormFieldDef[] }>(
	(props) => {
		const fields = useSignal<FormFieldDef[]>(props.initialFields);

		const update = $((index: number, patch: Partial<FormFieldDef>) => {
			fields.value = fields.value.map((f, i) =>
				i === index ? { ...f, ...patch } : f,
			);
		});
		const move = $((index: number, delta: -1 | 1) => {
			const next = [...fields.value];
			const target = index + delta;
			if (target < 0 || target >= next.length) return;
			[next[index], next[target]] = [next[target], next[index]];
			fields.value = next;
		});

		return (
			<div class="grid gap-md">
				{fields.value.map((field, i) => (
					<div
						key={i}
						class="grid gap-sm bg-surface1 border border-border rounded-component p-md"
					>
						<div class="flex gap-sm items-center flex-wrap">
							<input
								type="text"
								value={field.label}
								placeholder="Field label"
								aria-label="Field label"
								class="flex-1 min-w-[160px] px-sm py-xs rounded-control bg-surface3 text-text1 border border-border"
								onInput$={(e) =>
									update(i, { label: (e.target as HTMLInputElement).value })
								}
							/>
							<select
								value={field.type}
								aria-label="Field type"
								class="px-sm py-xs rounded-control bg-surface3 text-text1 border border-border"
								onChange$={(e) =>
									update(i, {
										type: (e.target as HTMLSelectElement)
											.value as FormFieldType,
									})
								}
							>
								{FIELD_TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
							<label class="flex items-center gap-xs text-body-sm text-text2">
								<input
									type="checkbox"
									checked={field.required}
									class="accent-accent"
									onChange$={(e) =>
										update(i, {
											required: (e.target as HTMLInputElement).checked,
										})
									}
								/>
								Required
							</label>
							<div class="flex gap-2xs">
								<button
									type="button"
									aria-label="Move up"
									class="px-sm py-2xs rounded-control border border-border-visible text-text1 cursor-pointer"
									onClick$={() => move(i, -1)}
								>
									↑
								</button>
								<button
									type="button"
									aria-label="Move down"
									class="px-sm py-2xs rounded-control border border-border-visible text-text1 cursor-pointer"
									onClick$={() => move(i, 1)}
								>
									↓
								</button>
								<button
									type="button"
									aria-label="Remove field"
									class="px-sm py-2xs rounded-control border border-error text-error cursor-pointer"
									onClick$={() => {
										fields.value = fields.value.filter((_, j) => j !== i);
									}}
								>
									✕
								</button>
							</div>
						</div>
						{(field.type === "select" || field.type === "multiselect") && (
							<textarea
								rows={3}
								value={optionsToText(field)}
								placeholder="value|Label — one per line"
								aria-label="Options"
								class="px-sm py-xs rounded-control bg-surface3 text-text1 border border-border font-mono text-caption"
								onInput$={(e) =>
									update(i, {
										options: textToOptions(
											(e.target as HTMLTextAreaElement).value,
										),
									})
								}
							/>
						)}
					</div>
				))}

				<button
					type="button"
					class="w-fit px-md py-sm rounded-control border border-border-visible text-text1 text-label cursor-pointer"
					onClick$={() => {
						const key = `field_${fields.value.length + 1}`;
						fields.value = [
							...fields.value,
							{
								key,
								label: "New field",
								type: "text",
								required: false,
								order: fields.value.length + 1,
							},
						];
					}}
				>
					+ Add field
				</button>

				<input
					type="hidden"
					name="fields"
					value={JSON.stringify(
						fields.value.map((f, i) => ({ ...f, order: i + 1 })),
					)}
				/>
			</div>
		);
	},
);
