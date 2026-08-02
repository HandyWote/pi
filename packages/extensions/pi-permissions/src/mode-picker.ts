/**
 * /permissions mode picker: an EntityList dialog (same UX as pi's /theme
 * selector) with the permission modes listed on the left and their
 * descriptions on the right. Enter selects and closes; Escape closes
 * without changing anything.
 */

import type { ExtensionCommandContext, Theme } from "@handy_wote/pi-coding-agent";
import type { EntityListItem, EntityListTheme } from "@handy_wote/pi-tui";
import { EntityList } from "@handy_wote/pi-tui";
import { ruleValueToString } from "./rules/index.ts";
import type { PermissionRuleStore } from "./rules/store.ts";
import type { PermissionMode, SessionState } from "./state.ts";

export const PERMISSION_MODES: readonly PermissionMode[] = ["chat", "acceptEdits", "auto"];

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
	chat: "读取类工具自动放行，写入与命令执行需询问",
	acceptEdits: "编辑类工具自动放行，其他操作仍询问",
	auto: "由 AI 分类器自动决策，无法分类时询问",
};

const VIEW_RULES_ID = "view-rules";
const VIEW_RULES_LABEL = "View rules";
const VIEW_RULES_DESCRIPTION = "查看当前模式与全部规则";

/** Build the picker items: the three modes (current one marked) plus a View rules entry. */
export function buildModePickerItems(currentMode: PermissionMode): EntityListItem[] {
	const items: EntityListItem[] = PERMISSION_MODES.map((mode) => {
		const current = mode === currentMode ? "(current) " : "";
		return { id: mode, label: mode, description: `${current}${MODE_DESCRIPTIONS[mode]}` };
	});
	items.push({ id: VIEW_RULES_ID, label: VIEW_RULES_LABEL, description: VIEW_RULES_DESCRIPTION });
	return items;
}

/** Same color mapping as pi's internal entity-list theme. */
function entityListTheme(theme: Theme): EntityListTheme {
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

/** Human-readable summary of the current mode and all rule groups. */
export function permissionsSummary(store: PermissionRuleStore, state: SessionState): string {
	const user = store.userRuleStrings();
	const session = store.collection().session.allow;
	const formatList = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));
	return [
		`Mode: ${state.getMode()}`,
		"User rules:",
		`  allow: ${formatList(user.allow ?? [])}`,
		`  deny: ${formatList(user.deny ?? [])}`,
		`  ask: ${formatList(user.ask ?? [])}`,
		"Session rules:",
		`  allow: ${formatList(session.map((rule) => ruleValueToString(rule)))}`,
		"CLI rules:",
		`  allow: ${formatList(store.cliAllow)}`,
		`  deny: ${formatList(store.cliDeny)}`,
	].join("\n");
}

/**
 * Show the mode picker via ctx.ui.custom and resolve when the dialog
 * closes (Enter selects a mode or View rules; Escape closes without
 * changing anything).
 */
export function showModePicker(
	ctx: ExtensionCommandContext,
	deps: {
		store: () => PermissionRuleStore | undefined;
		state: () => SessionState | undefined;
	},
): Promise<void> {
	return ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const store = deps.store();
		const state = deps.state();
		const currentMode = state?.getMode() ?? "chat";

		const list = new EntityList(buildModePickerItems(currentMode), {
			title: "Permission Mode",
			maxVisible: 10,
			theme: entityListTheme(theme),
			initialSelectedId: currentMode,
		});

		list.onActivate = (item) => {
			if (item.id === VIEW_RULES_ID) {
				if (store && state) ctx.ui.notify(permissionsSummary(store, state), "info");
				done();
				return;
			}
			state?.setMode(item.id as PermissionMode);
			ctx.ui.notify(`Permission mode set to ${item.id}`, "info");
			done();
		};
		list.onCancel = () => {
			done();
		};

		// Return the EntityList directly (not wrapped in a Container): the
		// runtime calls setFocus() on the returned component and forwards
		// keyboard input to its handleInput(), which Container lacks.
		return list;
	});
}
