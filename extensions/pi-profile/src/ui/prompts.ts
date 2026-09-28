/**
 * Thin prompt helpers over the official extension UI context.
 *
 * These replace the fork's private `showExtensionEditor` / `showExtensionSelector`
 * / `showExtensionConfirm` / `showError` helpers so the profile flows only
 * depend on the public `ExtensionUIContext` contract.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type NotifyType = "info" | "warning" | "error";

/** Multi-line text editor with prefill (fork `showExtensionEditor`). */
export function promptText(ctx: ExtensionCommandContext, title: string, current: string): Promise<string | undefined> {
	return ctx.ui.editor(title, current);
}

/** Single-line text input without prefill (for new secrets/ids). */
export function promptLine(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	return ctx.ui.input(title, placeholder);
}

export function confirmDialog(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
	return ctx.ui.confirm(title, message);
}

export function selectOption(
	ctx: ExtensionCommandContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	return ctx.ui.select(title, options);
}

export function notify(ctx: ExtensionCommandContext, message: string, type: NotifyType = "info"): void {
	ctx.ui.notify(message, type);
}

/** Prompt for a strictly positive integer, re-notifying on invalid input. */
export async function promptPositiveInteger(
	ctx: ExtensionCommandContext,
	title: string,
	current: number,
): Promise<number | undefined> {
	const value = await promptText(ctx, title, String(current));
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		notify(ctx, `${title} must be a positive integer.`, "error");
		return undefined;
	}
	return parsed;
}
