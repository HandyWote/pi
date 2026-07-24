/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@handy_wote/pi-ai";
import { fuzzyFilter } from "@handy_wote/pi-tui";
import chalk from "chalk";
import { formatModelReference, getModelReferenceSearchText } from "../core/model-reference.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { resolveProfileModelApi } from "../core/profile-api-resolution.ts";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(modelRuntime: ModelRuntime, searchPattern?: string): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: model runtime errors:\n${loadError}`));
	}

	const models = [...modelRuntime.getModels()];

	if (models.length === 0) {
		if (modelRuntime.getProfiles().length === 0) {
			console.log("No profiles configured. Use /profile to create one.");
		} else {
			console.log("No selectable models. Enable a model in /profile.");
			for (const profile of modelRuntime.getProfiles()) {
				if (profile.models.length === 0) continue;
				const disabled = profile.models.filter((model) => !model.enabled).length;
				const unavailable = profile.models.filter((model) => model.available === false).length;
				const unresolved = profile.models.filter(
					(model) =>
						model.enabled &&
						model.available !== false &&
						!resolveProfileModelApi(profile, model, {
							registrySources: modelRuntime.getCompatRegistries?.(),
						}).api,
				).length;
				const reasons = [
					disabled > 0 ? `${disabled} disabled` : undefined,
					unavailable > 0 ? `${unavailable} unavailable` : undefined,
					unresolved > 0 ? `${unresolved} unresolved API` : undefined,
				].filter((reason): reason is string => reason !== undefined);
				console.log(`  ${profile.name}: ${reasons.length > 0 ? reasons.join(", ") : "no selectable models"}`);
			}
		}
		return;
	}

	// Apply fuzzy filter if search pattern provided
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m: Model<Api>) => {
			return `${modelRuntime.getProviderName(m.provider)} ${m.provider} ${getModelReferenceSearchText(m)}`;
		});
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	const activeProfileId = modelRuntime.getActiveProfile()?.id;

	// Keep the active profile first, then make the owning profile and model easy to scan.
	filteredModels.sort((a, b) => {
		const aActive = a.provider === activeProfileId;
		const bActive = b.provider === activeProfileId;
		if (aActive !== bActive) return aActive ? -1 : 1;
		const profileOrder = modelRuntime
			.getProviderName(a.provider)
			.localeCompare(modelRuntime.getProviderName(b.provider));
		return profileOrder !== 0 ? profileOrder : a.id.localeCompare(b.id);
	});

	// Calculate column widths
	const rows = filteredModels.map((m) => ({
		active: m.provider === activeProfileId ? "*" : "",
		profile: modelRuntime.getProviderName(m.provider),
		model: m.id,
		reference: formatModelReference(m),
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	const headers = {
		active: "active",
		profile: "profile",
		model: "model",
		reference: "reference",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	const widths = {
		active: Math.max(headers.active.length, ...rows.map((r) => r.active.length)),
		profile: Math.max(headers.profile.length, ...rows.map((r) => r.profile.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		reference: Math.max(headers.reference.length, ...rows.map((r) => r.reference.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// Print header
	const headerLine = [
		headers.active.padEnd(widths.active),
		headers.profile.padEnd(widths.profile),
		headers.model.padEnd(widths.model),
		headers.reference.padEnd(widths.reference),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	// Print rows
	for (const row of rows) {
		const line = [
			row.active.padEnd(widths.active),
			row.profile.padEnd(widths.profile),
			row.model.padEnd(widths.model),
			row.reference.padEnd(widths.reference),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
		].join("  ");
		console.log(line);
	}
}
