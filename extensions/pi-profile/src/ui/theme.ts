/**
 * EntityList theme adapter.
 *
 * The fork's entity-list theme used the coding-agent's global `theme`
 * singleton. Extensions load through a separate module cache, so the global
 * may not be the same instance; this adapter builds the theme from the
 * `Theme` object the extension UI context provides instead.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EntityListTheme } from "./entity-list.ts";

/** Map the app `Theme` onto the pi-tui `EntityListTheme` contract. */
export function createEntityListTheme(theme: Theme): EntityListTheme {
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
