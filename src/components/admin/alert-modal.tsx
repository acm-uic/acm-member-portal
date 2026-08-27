import { component$ } from "@builder.io/qwik";
import type { QRL } from "@builder.io/qwik";

export const AlertModal = component$<{
	title: string;
	message: string;
	onClose$: QRL<() => void>;
}>(({ title, message, onClose$ }) => {
	return (
		<div class="fixed inset-0 z-50 grid place-items-center p-md">
			<button
				type="button"
				class="absolute inset-0 bg-black/50 border-0 cursor-pointer"
				aria-label="Close"
				onClick$={onClose$}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="alert-modal-title"
				class="relative max-w-md w-full bg-surface1 border border-border rounded-component shadow-overlay p-lg grid gap-md"
			>
				<h2 id="alert-modal-title" class="font-display text-subheading m-0">
					{title}
				</h2>
				<p class="text-text2 text-body m-0">{message}</p>
				<div class="flex justify-end">
					<button
						type="button"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
						onClick$={onClose$}
					>
						OK
					</button>
				</div>
			</div>
		</div>
	);
});
