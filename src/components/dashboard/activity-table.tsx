import { component$ } from "@builder.io/qwik";
import type { MetricTone } from "./metric-card";

export interface ActivityRow {
	cells: string[];
	status?: { text: string; tone: MetricTone };
}

const TONE_CLASS = {
	success: "bg-success-bg text-success",
	warning: "bg-warning-bg text-warning",
	error: "bg-error-bg text-error",
} as const;

/** Compact data table (archetype `.table`): mono first column, status tints. */
export const ActivityTable = component$<{
	columns: string[];
	rows: ActivityRow[];
}>((props) => (
	<table class="w-full border-collapse text-caption">
		<thead>
			<tr>
				{props.columns.map((col) => (
					<th
						key={col}
						class="text-left text-text3 font-semibold py-sm px-sm border-t border-border"
					>
						{col}
					</th>
				))}
			</tr>
		</thead>
		<tbody>
			{props.rows.map((row, i) => (
				<tr key={i}>
					{row.cells.map((cell, j) => (
						<td
							key={j}
							class={`py-sm px-sm border-t border-border ${j === 0 ? "font-mono text-text3" : "text-text1"}`}
						>
							{cell}
						</td>
					))}
					{row.status && (
						<td class="py-sm px-sm border-t border-border">
							<span
								class={`px-sm py-2xs rounded-element font-semibold ${TONE_CLASS[row.status.tone]}`}
							>
								{row.status.text}
							</span>
						</td>
					)}
				</tr>
			))}
		</tbody>
	</table>
));
