/**
 * Pure profile-UI helpers.
 *
 * Kept free of any coding-agent / TUI imports so they can be unit tested
 * without loading the interactive UI graph. `profile-ui.ts` composes these
 * into the interactive flows.
 */

import type { RegistryApi } from "@earendil-works/pi-ai";
import { getProfileApiLabel, PROFILE_API_SERIALIZERS, resolveProfileModelApi } from "../profile-api-resolution.ts";
import type { Profile, ProfileApiPreference, UserModel } from "../profiles-types.ts";

export interface ProfileGroupSummary {
	groupId: string;
	label: string;
	enabledCount: number;
	availableCount: number;
	unavailableCount: number;
	apiLabel: string;
	toggled: boolean;
	models: UserModel[];
}

export interface ApiPreferenceChoice {
	label: string;
	value: ProfileApiPreference;
}

/** Build the API preference choices shown for a profile/family/model. */
export function buildApiPreferenceChoices(
	current: ProfileApiPreference | undefined,
	availableApis: readonly RegistryApi[],
	autoDescription: string,
	includeAllInstalled = true,
): ApiPreferenceChoice[] {
	const explicitCurrent = current && current !== "auto" ? current : undefined;
	const installed = new Set<RegistryApi>(PROFILE_API_SERIALIZERS);
	const apis = Array.from(
		new Set<RegistryApi>([
			...availableApis.filter((api) => installed.has(api)),
			...(includeAllInstalled ? PROFILE_API_SERIALIZERS : []),
			...(explicitCurrent ? [explicitCurrent] : []),
		]),
	);
	return [
		{ label: autoDescription, value: "auto" },
		...apis.map((api) => ({ label: getProfileApiLabel(api), value: api })),
	];
}

/** Group a profile's models for the models editor and summarize each group. */
export function buildProfileGroupSummaries(profile: Profile): ProfileGroupSummary[] {
	const groups = new Map<string, { label: string; models: UserModel[] }>();
	for (const model of profile.models) {
		const group = model.group ?? { id: "other", label: "Other models" };
		const current = groups.get(group.id);
		if (current) current.models.push(model);
		else groups.set(group.id, { label: group.label, models: [model] });
	}
	return Array.from(groups, ([groupId, group]) => {
		const available = group.models.filter((model) => model.available !== false);
		const enabledCount = available.filter((model) => model.enabled).length;
		return {
			groupId,
			label: group.label,
			enabledCount,
			availableCount: available.length,
			unavailableCount: group.models.length - available.length,
			apiLabel: formatProfileFamilyApi(profile, groupId, group.models),
			toggled: enabledCount === available.length && available.length > 0,
			models: group.models,
		};
	});
}

/** Drop discovered routes/warnings while keeping manual (unverified) routes. */
export function clearProfileDiscoveryState(profile: Profile): Profile {
	const rest = { ...profile };
	const manualRoutes: NonNullable<Profile["apiRoutes"]> = Object.fromEntries(
		Object.entries(profile.apiRoutes ?? {}).filter(([, route]) => route.verified === false),
	);
	if (Object.keys(manualRoutes).length > 0) {
		rest.apiRoutes = manualRoutes;
		rest.availableApis = Object.keys(manualRoutes) as RegistryApi[];
	} else {
		delete rest.apiRoutes;
		delete rest.availableApis;
	}
	delete rest.discoveryWarnings;
	delete rest.lastDiscoveredAt;
	return rest;
}

/** Describe the effective API route for one model. */
export function formatProfileModelApi(profile: Profile, model: UserModel): string {
	const preference = model.apiPreference ?? "auto";
	const resolution = resolveProfileModelApi(profile, model);
	const routeStatus =
		resolution.api && profile.apiRoutes?.[resolution.api]?.verified === false ? " · unverified route" : "";
	if (preference !== "auto") {
		const label = getProfileApiLabel(preference);
		return resolution.api
			? `${label}${routeStatus}`
			: `${label} · unresolved: ${resolution.reason ?? "select an API"}`;
	}
	return resolution.api
		? `Auto -> ${getProfileApiLabel(resolution.api)}${routeStatus}`
		: `Auto -> unresolved: ${resolution.reason ?? "select an API"}`;
}

/** One-line model summary used as the EntityList description. */
export function formatProfileModelDescription(profile: Profile, model: UserModel): string {
	const details = [
		model.overrides?.name ?? model.name,
		formatProfileModelApi(profile, model),
		model.enabled ? "enabled" : "disabled",
	];
	if (model.available === false) details.push("unavailable");
	return details.join(" · ");
}

/** Describe the effective API policy for a model family/group. */
export function formatProfileFamilyApi(profile: Profile, groupId: string, models: UserModel[]): string {
	const preference = profile.familyApiPreferences?.[groupId] ?? "auto";
	if (preference !== "auto") return getProfileApiLabel(preference);
	const resolved = new Set(models.map((model) => resolveProfileModelApi(profile, model).api));
	if (resolved.has(undefined)) return "Auto -> Unresolved";
	if (resolved.size !== 1) return "Auto -> Mixed";
	const api = resolved.values().next().value;
	return api ? `Auto -> ${getProfileApiLabel(api)}` : "Auto -> Unresolved";
}

/** APIs selectable for a profile or one of its models. */
export function getProfileSelectableApis(profile: Profile, model?: UserModel): RegistryApi[] {
	if (profile.apiRoutes) return Object.keys(profile.apiRoutes) as RegistryApi[];
	return Array.from(new Set(model?.availableApis?.length ? model.availableApis : (profile.availableApis ?? [])));
}
