import type { EntityListTheme } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export function getEntityListTheme(): EntityListTheme {
	return {
		title: (text) => theme.fg("accent", theme.bold(text)),
		cursor: (text) => theme.fg("accent", text),
		selected: (text) => theme.fg("accent", text),
		label: (text) => theme.fg("text", text),
		description: (text) => theme.fg("muted", text),
		toggled: (text) => theme.fg("success", text),
		untoggled: (text) => theme.fg("dim", text),
		hint: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
		deletePending: (text) => theme.fg("error", text),
	};
}
