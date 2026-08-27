import { component$ } from "@builder.io/qwik";
import type { FormFieldDef } from "~/lib/types";

export const DynamicField = component$<{
	field: FormFieldDef;
	error?: string;
	/** Pre-fill (profile edit). Signup omits it. (Added in Phase 8.) */
	value?: string | string[];
}>(({ field, error, value }) => {
	const describedBy = error ? `${field.key}-error` : undefined;
	const text = typeof value === "string" ? value : "";
	const selected = Array.isArray(value) ? value : [];
	return (
		<div class="grid gap-xs min-w-0">
			<label for={field.key} class="text-label text-text2">
				{field.label}
				{field.required && (
					<span class="text-accent" aria-hidden="true">
						{" "}
						*
					</span>
				)}
			</label>

			{field.type === "textarea" ? (
				<textarea
					id={field.key}
					name={field.key}
					rows={4}
					placeholder={field.placeholder}
					aria-invalid={!!error}
					aria-describedby={describedBy}
					class="w-full min-w-0 px-sm py-sm rounded-control bg-surface3 text-text1 border border-border focus:border-border-visible outline-none"
				>
					{text}
				</textarea>
			) : field.type === "select" ? (
				<select
					id={field.key}
					name={field.key}
					aria-invalid={!!error}
					aria-describedby={describedBy}
					class="w-full min-w-0 px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
				>
					<option value="">Select…</option>
					{(field.options ?? []).map((o) => (
						<option key={o.value} value={o.value} selected={text === o.value}>
							{o.label}
						</option>
					))}
				</select>
			) : field.type === "multiselect" ? (
				<fieldset class="grid gap-xs border-0 p-0 m-0">
					<legend class="sr-only">{field.label}</legend>
					{(field.options ?? []).map((o) => (
						<label
							key={o.value}
							class="flex items-center gap-sm text-body-sm text-text2"
						>
							<input
								type="checkbox"
								name={field.key}
								value={o.value}
								checked={selected.includes(o.value)}
								class="accent-accent"
							/>
							{o.label}
						</label>
					))}
				</fieldset>
			) : field.type === "checkbox" ? (
				<input
					id={field.key}
					name={field.key}
					type="checkbox"
					value="true"
					checked={text === "true"}
					aria-invalid={!!error}
					class="accent-accent h-4 w-4"
				/>
			) : (
				<input
					id={field.key}
					name={field.key}
					type={
						field.type === "email"
							? "email"
							: field.type === "number"
								? "number"
								: "text"
					}
					inputMode={field.type === "number" ? "numeric" : undefined}
					placeholder={field.placeholder}
					minLength={field.minLength}
					maxLength={field.maxLength}
					value={text}
					aria-invalid={!!error}
					aria-describedby={describedBy}
					class="w-full min-w-0 px-sm py-sm rounded-control bg-surface3 text-text1 border border-border focus:border-border-visible outline-none"
				/>
			)}

			{field.helpText && (
				<p class="text-caption text-text3 m-0">{field.helpText}</p>
			)}
			{error && (
				<p
					id={`${field.key}-error`}
					role="alert"
					class="text-caption text-error m-0"
				>
					{error}
				</p>
			)}
		</div>
	);
});
