/**
 * Interactive /profile management UI.
 *
 * Ports the fork's profile UI (packages/coding-agent interactive-mode) onto the
 * official extension API. Differences from the fork, per the agreed profile
 * architecture:
 *
 * - No active-profile switching: every profile's enabled models compile into
 *   one models.json and the user selects among them with the official /model
 *   entry. Profile list items are therefore not toggleable.
 * - No plaintext API key on the profile: authentication is an auth.json
 *   provider-id reference (`profile.authReference.authProviderId`).
 * - No `supportsToolCall` management: official model config has no compilable
 *   field for it.
 * - No model pre-selection after adding a manual model (the extension cannot
 *   set the session model); the UI points the user at /model instead.
 *
 * The UI only talks to the public `ExtensionUIContext` and the profile backend
 * modules; it never reaches into the coding-agent internals.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EntityListItem } from "@handy_wote/pi-tui";
import { hasStoredApiKey, saveApiKey } from "../auth-json.ts";
import type { CompileDiagnostic } from "../compiler.ts";
import { enrichWithModelsDev, mergeProfileModels } from "../model-metadata.ts";
import { getProfileApiLabel } from "../profile-api-resolution.ts";
import type { RegistryApi } from "../profile-api-types.ts";
import { discoverProfile, type ProfileDiscoveryCandidate, verifyProfileRoute } from "../profile-discovery.ts";
import {
	buildManualProtocolRoute,
	type ProfileDiscoveryApi,
	validateAutomaticProfileRootUrl,
} from "../profile-endpoints.ts";
import { compileAndWriteModelsJson } from "../profile-manager.ts";
import type { ProfilesStore } from "../profiles-store.ts";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type Profile,
	type ProfileApiPreference,
	type UserModel,
} from "../profiles-types.ts";
import { showEntityListDialog } from "./entity-list-dialog.ts";
import {
	buildApiPreferenceChoices,
	buildProfileGroupSummaries,
	clearProfileDiscoveryState,
	formatProfileFamilyApi,
	formatProfileModelApi,
	formatProfileModelDescription,
	getProfileSelectableApis,
} from "./profile-helpers.ts";
import { confirmDialog, notify, promptLine, promptPositiveInteger, promptText, selectOption } from "./prompts.ts";

/** APIs a profile can route at the gateway. */
const PROFILE_ROUTE_APIS: readonly RegistryApi[] = ["anthropic-messages", "openai-completions", "openai-responses"];

/** Dependencies the UI needs from the extension host. */
export interface ProfileUiOptions {
	store: ProfilesStore;
	/** Override for tests; defaults to the official models.json path. */
	modelsJsonPath?: string;
	/** Reload the official runtime after models.json changes (ctx.modelRegistry.refresh). */
	refresh?: () => Promise<void>;
}

// ============================================================================
// Entry point
// ============================================================================

/** Open the profile management UI (the `/profile` command body). */
export async function runProfileUi(ctx: ExtensionCommandContext, options: ProfileUiOptions): Promise<void> {
	await showProfileMenu(ctx, options);
}

// ============================================================================
// Profile list
// ============================================================================

async function showProfileMenu(ctx: ExtensionCommandContext, options: ProfileUiOptions): Promise<void> {
	let selectedId: string | undefined;
	while (true) {
		const profiles = options.store.list();
		const items: EntityListItem[] = profiles.map((profile) => {
			const enabledCount = profile.models.filter((model) => model.enabled).length;
			return {
				id: profile.id,
				label: profile.name,
				description: `${enabledCount}/${profile.models.length} enabled · ${profile.baseUrl}`,
				deletable: true,
			};
		});
		items.push({ id: "__create__", label: "[ Create new profile ]" });

		const result = await showEntityListDialog(ctx, "Profiles", items, {
			initialSelectedId: selectedId,
			renderEmpty: () => [ctx.ui.theme.fg("muted", "  No profiles configured")],
		});
		if (!result) return;
		selectedId = result.item.id;

		if (result.item.id === "__create__") {
			if (result.action === "activate") await createProfile(ctx, options);
			continue;
		}

		const profile = options.store.get(result.item.id);
		if (!profile) continue;

		if (result.action === "delete") {
			const confirmed = await confirmDialog(
				ctx,
				"Delete profile",
				`Delete "${profile.name}" and recompile models.json?`,
			);
			if (!confirmed) continue;
			options.store.delete(profile.id);
			await recompile(ctx, options);
			notify(ctx, `Deleted profile: ${profile.name}`, "info");
			continue;
		}

		if (result.action === "activate") await showExistingProfileMenu(ctx, options, profile.id);
	}
}

async function createProfile(ctx: ExtensionCommandContext, options: ProfileUiOptions): Promise<void> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const draft: Profile = {
		id,
		name: "New profile",
		baseUrl: "",
		// The compiled provider id is the profile id, and auth.json credentials
		// are keyed by provider id, so the reference defaults to the same id.
		authReference: { authProviderId: id },
		models: [],
		createdAt: now,
		updatedAt: now,
	};
	await showProfileEditor(ctx, options, draft, true);
}

// ============================================================================
// Profile detail
// ============================================================================

async function showExistingProfileMenu(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profileId: string,
): Promise<void> {
	let selectedId: string | undefined;
	while (true) {
		const profile = options.store.get(profileId);
		if (!profile) {
			notify(ctx, "Profile no longer exists.", "warning");
			return;
		}

		const enabledCount = profile.models.filter((model) => model.enabled).length;
		const routeCount = Object.keys(profile.apiRoutes ?? {}).length;
		const result = await showEntityListDialog(
			ctx,
			`Profile: ${profile.name}`,
			[
				{ id: "models", label: "Models", description: `${enabledCount}/${profile.models.length} enabled` },
				{
					id: "refresh",
					label: "Refresh discovery",
					description: profile.lastDiscoveredAt ? `Last: ${profile.lastDiscoveredAt}` : "Not discovered",
				},
				{
					id: "routes",
					label: "API routes",
					description: routeCount > 0 ? `${routeCount} configured` : "None configured",
				},
				{ id: "connection", label: "Edit connection", description: profile.baseUrl },
			],
			{ initialSelectedId: selectedId },
		);
		if (!result) return;
		selectedId = result.item.id;
		if (result.action !== "activate") continue;

		if (result.item.id === "models") {
			await showProfileModelsEditor(ctx, options, profile.id);
		} else if (result.item.id === "refresh") {
			const refreshed = await discoverAndLoadModels(ctx, profile);
			if (refreshed) {
				await saveProfileToStore(ctx, options, refreshed, false);
				await showProfileModelsEditor(ctx, options, profile.id);
			}
		} else if (result.item.id === "routes") {
			await showProfileRoutesEditor(ctx, options, profile.id);
		} else if (result.item.id === "connection") {
			await showProfileEditor(ctx, options, profile, false);
		}
	}
}

// ============================================================================
// Connection editor
// ============================================================================

async function showProfileEditor(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profile: Profile,
	isNew: boolean,
): Promise<void> {
	let draft: Profile = { ...profile, models: profile.models.map((model) => ({ ...model })) };
	let selectedId: string | undefined;

	while (true) {
		const actionLabel = isNew ? "Connect and discover" : "Save connection";
		const fallbackPreference = draft.apiPreference ?? "auto";
		const items: EntityListItem[] = [
			{ id: "name", label: "Name", description: draft.name },
			{
				id: "url",
				label: "Base URL",
				description: draft.baseUrl || "service root URL; do not add /v1 or /models",
			},
			{
				id: "apiKey",
				label: "API Key",
				description: hasStoredApiKey(draft.authReference.authProviderId) ? "Configured" : "Not configured",
			},
			...(isNew
				? []
				: [
						{
							id: "fallback",
							label: "Fallback API",
							description: fallbackPreference === "auto" ? "Auto" : getProfileApiLabel(fallbackPreference),
						},
					]),
			...(isNew ? [{ id: "manual", label: "Configure manually" }] : []),
			{ id: "save", label: actionLabel },
		];

		const result = await showEntityListDialog(ctx, isNew ? "Create profile" : `Edit profile: ${draft.name}`, items, {
			initialSelectedId: selectedId,
		});
		if (!result) return;
		selectedId = result.item.id;
		if (result.action !== "activate") continue;

		if (result.item.id === "name") {
			const value = await promptText(ctx, "Profile name", draft.name);
			if (value !== undefined) draft = { ...draft, name: value.trim() || draft.name };
			continue;
		}

		if (result.item.id === "url") {
			const value = await promptText(ctx, "Base URL", draft.baseUrl);
			if (value !== undefined) {
				const baseUrl = value.trim();
				draft =
					baseUrl === draft.baseUrl ? { ...draft, baseUrl } : clearProfileDiscoveryState({ ...draft, baseUrl });
			}
			continue;
		}

		if (result.item.id === "apiKey") {
			const value = await promptLine(ctx, "API Key");
			if (value === undefined) continue;
			try {
				saveApiKey(draft.authReference.authProviderId, value);
				notify(ctx, "API key saved in Pi auth.json.", "info");
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}

		if (result.item.id === "fallback") {
			const preference = await selectProfileApiPreference(
				ctx,
				"Fallback API",
				draft.apiPreference,
				getProfileSelectableApis(draft),
				"Auto",
				draft.apiRoutes === undefined,
			);
			if (preference !== undefined) draft = { ...draft, protocol: undefined, apiPreference: preference };
			continue;
		}

		if (result.item.id === "manual") {
			if (!draft.baseUrl.trim()) {
				notify(ctx, "Profile URL is required.", "error");
				continue;
			}
			await saveProfileToStore(ctx, options, { ...clearProfileDiscoveryState(draft), models: [] }, true);
			await showExistingProfileMenu(ctx, options, draft.id);
			return;
		}

		if (result.item.id === "save") {
			if (!draft.baseUrl.trim()) {
				notify(ctx, "Profile URL is required.", "error");
				continue;
			}
			if (isNew) {
				const discovered = await discoverAndLoadModels(ctx, draft);
				if (!discovered) continue;
				await saveProfileToStore(ctx, options, discovered, true);
				await showProfileModelsEditor(ctx, options, discovered.id);
				return;
			}
			await saveProfileToStore(ctx, options, draft, false);
			return;
		}
	}
}

// ============================================================================
// Discovery
// ============================================================================

async function discoverAndLoadModels(ctx: ExtensionCommandContext, profile: Profile): Promise<Profile | undefined> {
	if (!profile.baseUrl.trim()) {
		notify(ctx, "Profile URL is required before discovery.", "error");
		return undefined;
	}

	notify(ctx, "Discovering models and APIs...", "info");
	try {
		const baseUrl = validateAutomaticProfileRootUrl(profile.baseUrl);
		const discovery = await discoverProfile({ ...profile, baseUrl });
		if (discovery.candidates.length === 0) {
			const failureSummary = discovery.failures
				.slice(0, 3)
				.map((failure) => `${failure.route.api} ${failure.stage}: ${failure.message}`)
				.join("; ");
			notify(
				ctx,
				failureSummary
					? `No confirmed API route was discovered. ${failureSummary}`
					: "No confirmed API route was discovered. Configure an API route manually.",
				"error",
			);
			return undefined;
		}

		const candidate = await selectProfileDiscoveryCandidate(ctx, discovery.candidates);
		if (!candidate) return undefined;
		if (candidate.models.length === 0) {
			notify(ctx, "The model catalog is empty. Configure a model manually before saving this profile.", "error");
			return undefined;
		}

		const enrichedModels = await enrichWithModelsDev(candidate.models);
		const models = mergeProfileModels(profile.models, enrichedModels);
		const apiRoutes = Object.fromEntries(
			Object.entries(candidate.protocolRoutes).map(([api, route]) => [
				api,
				{ sdkBaseUrl: route.sdkBaseUrl, verified: true },
			]),
		) as Profile["apiRoutes"];
		const failureWarnings = discovery.failures.map(
			(failure) => `${failure.route.api} ${failure.stage}: ${failure.message}`,
		);
		const now = new Date().toISOString();
		notify(ctx, `Discovered ${candidate.models.length} models for ${profile.name}.`, "info");
		return {
			...profile,
			baseUrl,
			models,
			availableApis: candidate.availableApis,
			apiRoutes,
			discoveryWarnings: [...candidate.warnings, ...failureWarnings],
			lastDiscoveredAt: now,
			updatedAt: now,
		};
	} catch (error) {
		notify(ctx, `Profile test failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

async function selectProfileDiscoveryCandidate(
	ctx: ExtensionCommandContext,
	candidates: readonly ProfileDiscoveryCandidate[],
): Promise<ProfileDiscoveryCandidate | undefined> {
	if (candidates.length === 1) return candidates[0];
	const items: EntityListItem[] = candidates.map((candidate, index) => ({
		id: candidate.id,
		label: `Discovery candidate ${index + 1}`,
		description: [
			`${candidate.models.length} models`,
			candidate.availableApis.map((api) => getProfileApiLabel(api)).join(", "),
			...Object.values(candidate.protocolRoutes)
				.filter((route): route is NonNullable<typeof route> => route !== undefined)
				.map((route) => `${getProfileApiLabel(route.api)}: ${route.sdkBaseUrl}`),
		].join(" · "),
	}));
	const result = await showEntityListDialog(ctx, "Choose discovered routes", items, {
		renderEmpty: () => [ctx.ui.theme.fg("muted", "  No discovery candidates")],
	});
	return result?.action === "activate" ? candidates.find((candidate) => candidate.id === result.item.id) : undefined;
}

// ============================================================================
// API routes
// ============================================================================

async function showProfileRoutesEditor(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profileId: string,
): Promise<void> {
	let selectedId: string | undefined;
	while (true) {
		const profile = options.store.get(profileId);
		if (!profile) return;
		const routes = Object.entries(profile.apiRoutes ?? {});
		const items: EntityListItem[] = routes.map(([api, route]) => ({
			id: `route:${api}`,
			label: getProfileApiLabel(api as RegistryApi),
			description: `${route.sdkBaseUrl} · ${route.verified === false ? "unverified" : "verified"}`,
			deletable: true,
		}));
		items.push({ id: "__add__", label: "[ Add API route ]" });
		const result = await showEntityListDialog(ctx, `API routes: ${profile.name}`, items, {
			initialSelectedId: selectedId,
			renderEmpty: () => [ctx.ui.theme.fg("muted", "  No API routes configured")],
		});
		if (!result) return;
		selectedId = result.item.id;

		if (result.item.id === "__add__" && result.action === "activate") {
			await addProfileApiRoute(ctx, options, profile);
			continue;
		}
		if (result.action === "delete" && result.item.id.startsWith("route:")) {
			const api = result.item.id.slice("route:".length) as RegistryApi;
			const apiRoutes = { ...profile.apiRoutes };
			delete apiRoutes[api];
			const availableApis = (profile.availableApis ?? []).filter((entry) => entry !== api);
			const models = profile.models.map((model) =>
				model.apiPreference === api ? { ...model, apiPreference: "auto" as const } : model,
			);
			const familyApiPreferences = Object.fromEntries(
				Object.entries(profile.familyApiPreferences ?? {}).map(([groupId, preference]) => [
					groupId,
					preference === api ? "auto" : preference,
				]),
			);
			await saveProfileToStore(
				ctx,
				options,
				{ ...profile, apiRoutes, availableApis, models, familyApiPreferences },
				false,
			);
		}
	}
}

async function addProfileApiRoute(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profile: Profile,
): Promise<void> {
	const api = await selectProfileRouteApi(ctx, "API route type", PROFILE_ROUTE_APIS);
	if (!api) return;
	const current = profile.apiRoutes?.[api]?.sdkBaseUrl ?? profile.baseUrl;
	const sdkBaseUrl = (await promptText(ctx, "SDK base URL", current))?.trim();
	if (!sdkBaseUrl) return;
	try {
		const parsed = new URL(sdkBaseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("use http or https");
	} catch (error) {
		notify(ctx, `SDK base URL is invalid: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const route = buildManualProtocolRoute(api as ProfileDiscoveryApi, sdkBaseUrl);
	const verification = await verifyProfileRoute(profile, route);
	const verified = verification.confirmed;
	if (!verified) {
		const saveUnverified = await confirmDialog(
			ctx,
			"Route not confirmed",
			`${verification.failure ?? "The endpoint did not return a recognized protocol error."} Save it as unverified?`,
		);
		if (!saveUnverified) return;
		notify(ctx, "Saving an unverified API route; requests may fail.", "warning");
	}

	const apiRoutes = { ...profile.apiRoutes, [api]: { sdkBaseUrl: route.sdkBaseUrl, verified } };
	const availableApis = Array.from(new Set([...(profile.availableApis ?? []), api]));
	await saveProfileToStore(ctx, options, { ...profile, apiRoutes, availableApis }, false);
	notify(ctx, `${getProfileApiLabel(api)} route saved${verified ? " and verified" : " as unverified"}.`, "info");
}

async function selectProfileRouteApi(
	ctx: ExtensionCommandContext,
	title: string,
	allowedApis: readonly RegistryApi[],
	current?: RegistryApi,
): Promise<RegistryApi | undefined> {
	const apis = Array.from(new Set([...allowedApis, ...(current ? [current] : [])]));
	const selection = await selectOption(
		ctx,
		title,
		apis.map((api) => getProfileApiLabel(api)),
	);
	return apis.find((api) => getProfileApiLabel(api) === selection);
}

// ============================================================================
// Models
// ============================================================================

async function showProfileModelsEditor(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profileId: string,
): Promise<void> {
	let selectedId: string | undefined;
	while (true) {
		const profile = options.store.get(profileId);
		if (!profile) return;
		const groups = buildProfileGroupSummaries(profile);
		const items: EntityListItem[] = groups.map((group) => {
			const details = [`${group.enabledCount}/${group.availableCount} enabled`, group.apiLabel];
			if (group.unavailableCount > 0) details.push(`${group.unavailableCount} unavailable`);
			return {
				id: `group:${group.groupId}`,
				label: group.label,
				description: details.join(" · "),
				toggled: group.toggled,
				toggleable: group.availableCount > 0,
			};
		});
		for (const [index, warning] of (profile.discoveryWarnings ?? []).entries()) {
			items.push({ id: `warning:${index}`, label: "Discovery warning", description: warning });
		}
		items.push({ id: "__add_manual__", label: "[ Add manual model ]" });

		const result = await showEntityListDialog(ctx, `Models: ${profile.name}`, items, {
			initialSelectedId: selectedId,
			renderEmpty: () => [
				ctx.ui.theme.fg("muted", "  No models discovered. Refresh discovery from the Profile menu."),
			],
		});
		if (!result) return;
		selectedId = result.item.id;

		if (result.action === "activate" && result.item.id === "__add_manual__") {
			await addManualProfileModel(ctx, options, profile);
			continue;
		}
		if (!result.item.id.startsWith("group:")) continue;
		const groupId = result.item.id.slice("group:".length);
		const group = groups.find((entry) => entry.groupId === groupId);
		if (!group) continue;

		if (result.action === "activate") {
			await showProfileModelGroupEditor(ctx, options, profileId, groupId);
			continue;
		}
		if (result.action !== "toggle") continue;

		const available = group.models.filter((model) => model.available !== false);
		const enable = available.some((model) => !model.enabled);
		const ids = new Set(available.map((model) => model.id));
		const models = profile.models.map((model) => (ids.has(model.id) ? { ...model, enabled: enable } : model));
		await saveProfileToStore(ctx, options, { ...profile, models }, false);
	}
}

async function addManualProfileModel(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profile: Profile,
): Promise<void> {
	const id = (await promptLine(ctx, "Model ID"))?.trim();
	if (!id) return;
	if (profile.models.some((model) => model.id === id)) {
		notify(ctx, `Model already exists: ${id}`, "error");
		return;
	}
	const routeApis = Object.keys(profile.apiRoutes ?? {}) as RegistryApi[];
	if (routeApis.length === 0) {
		notify(ctx, "Configure an API route before adding a manual model.", "error");
		return;
	}
	const api = await selectProfileRouteApi(ctx, "Model API", routeApis);
	if (!api) return;
	const name = (await promptText(ctx, "Model name", id))?.trim() || id;
	const model: UserModel = {
		id,
		name,
		enabled: false,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsReasoning: false,
		supportsVision: false,
		metadataSource: "manual",
		availableApis: [api],
		apiPreference: api,
		available: true,
	};
	await saveProfileToStore(ctx, options, { ...profile, models: [...profile.models, model] }, false);

	const action = await selectOption(ctx, "Model added but not enabled", ["Enable now", "Keep disabled"]);
	if (action !== "Enable now") {
		notify(ctx, `Added disabled model: ${profile.name} (${profile.id}/${model.id})`, "info");
		return;
	}

	const currentProfile = options.store.get(profile.id);
	if (!currentProfile) return;
	const models = currentProfile.models.map((entry) => (entry.id === model.id ? { ...entry, enabled: true } : entry));
	await saveProfileToStore(ctx, options, { ...currentProfile, models }, false);
	notify(ctx, `Enabled model: ${profile.id}/${model.id}. Select it with /model.`, "info");
}

async function showProfileModelGroupEditor(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profileId: string,
	groupId: string,
): Promise<void> {
	let selectedId: string | undefined;
	let query = "";
	while (true) {
		const profile = options.store.get(profileId);
		if (!profile) return;
		const groupModels = profile.models.filter((model) => (model.group?.id ?? "other") === groupId);
		if (groupModels.length === 0) return;
		const groupLabel = groupModels[0].group?.label ?? "Other models";
		const items: EntityListItem[] = [
			{ id: "__enable_all__", label: "Enable all" },
			{ id: "__disable_all__", label: "Disable all" },
			{
				id: "__api__",
				label: "API policy",
				description: formatProfileFamilyApi(profile, groupId, groupModels),
			},
			...groupModels.map((model) => ({
				id: model.id,
				label: model.id,
				description: formatProfileModelDescription(profile, model),
				toggled: model.enabled,
				toggleable: true,
				deletable: model.metadataSource === "manual",
			})),
		];
		const result = await showEntityListDialog(ctx, `Models: ${groupLabel}`, items, {
			searchable: true,
			initialSelectedId: selectedId,
			initialQuery: query,
			getSearchText: (item) => `${item.id} ${item.label} ${item.description ?? ""}`,
		});
		if (!result) return;
		selectedId = result.item.id;
		query = result.query;

		if (
			result.action === "activate" &&
			(result.item.id === "__enable_all__" || result.item.id === "__disable_all__")
		) {
			const enabled = result.item.id === "__enable_all__";
			const ids = new Set(groupModels.filter((model) => model.available !== false).map((model) => model.id));
			const models = profile.models.map((model) => (ids.has(model.id) ? { ...model, enabled } : model));
			await saveProfileToStore(ctx, options, { ...profile, models }, false);
			continue;
		}

		if (result.action === "activate" && result.item.id === "__api__") {
			const availableApis = Array.from(
				new Set(
					groupModels.flatMap((model) =>
						model.availableApis?.length ? model.availableApis : (profile.availableApis ?? []),
					),
				),
			);
			const selectableApis = profile.apiRoutes ? getProfileSelectableApis(profile) : availableApis;
			const current = profile.familyApiPreferences?.[groupId];
			const preference = await selectProfileApiPreference(
				ctx,
				`API policy: ${groupLabel}`,
				current,
				selectableApis,
				formatProfileFamilyApi(
					{ ...profile, familyApiPreferences: { ...profile.familyApiPreferences, [groupId]: "auto" } },
					groupId,
					groupModels,
				),
				profile.apiRoutes === undefined,
			);
			if (preference === undefined) continue;
			await saveProfileToStore(
				ctx,
				options,
				{
					...profile,
					familyApiPreferences: { ...profile.familyApiPreferences, [groupId]: preference },
				},
				false,
			);
			continue;
		}

		const model = groupModels.find((entry) => entry.id === result.item.id);
		if (!model) continue;
		if (result.action === "delete" && model.metadataSource === "manual") {
			await saveProfileToStore(
				ctx,
				options,
				{ ...profile, models: profile.models.filter((entry) => entry.id !== model.id) },
				false,
			);
			continue;
		}
		if (result.action === "toggle") {
			const models = profile.models.map((entry) =>
				entry.id === model.id ? { ...entry, enabled: !entry.enabled } : entry,
			);
			await saveProfileToStore(ctx, options, { ...profile, models }, false);
		} else if (result.action === "activate") {
			const updated = await showProfileModelEditor(ctx, profile, model);
			const models = profile.models.map((entry) => (entry.id === updated.id ? updated : entry));
			await saveProfileToStore(ctx, options, { ...profile, models }, false);
		}
	}
}

async function showProfileModelEditor(
	ctx: ExtensionCommandContext,
	profile: Profile,
	model: UserModel,
): Promise<UserModel> {
	let draft: UserModel = { ...model };
	let selectedId: string | undefined;

	while (true) {
		const effectiveName = draft.overrides?.name ?? draft.name;
		const effectiveContextWindow = draft.overrides?.contextWindow ?? draft.contextWindow;
		const effectiveMaxTokens = draft.overrides?.maxTokens ?? draft.maxTokens;
		const effectiveReasoning = draft.overrides?.supportsReasoning ?? draft.supportsReasoning;
		const effectiveVision = draft.overrides?.supportsVision ?? draft.supportsVision;
		const result = await showEntityListDialog(
			ctx,
			`Model: ${draft.id}`,
			[
				{ id: "enabled", label: "Enabled", toggled: draft.enabled, toggleable: true },
				{ id: "api", label: "API", description: formatProfileModelApi(profile, draft) },
				{ id: "name", label: "Name", description: effectiveName },
				{ id: "context", label: "Context window", description: String(effectiveContextWindow) },
				{ id: "maxTokens", label: "Max tokens", description: String(effectiveMaxTokens) },
				{ id: "reasoning", label: "Reasoning", toggled: effectiveReasoning, toggleable: true },
				{ id: "vision", label: "Vision", toggled: effectiveVision, toggleable: true },
			],
			{ initialSelectedId: selectedId },
		);
		if (!result) return draft;
		selectedId = result.item.id;

		if (result.action === "toggle") {
			if (result.item.id === "enabled") draft = { ...draft, enabled: !draft.enabled };
			if (result.item.id === "reasoning") {
				draft = { ...draft, overrides: { ...draft.overrides, supportsReasoning: !effectiveReasoning } };
			}
			if (result.item.id === "vision") {
				draft = { ...draft, overrides: { ...draft.overrides, supportsVision: !effectiveVision } };
			}
			continue;
		}
		if (result.action !== "activate") continue;

		if (result.item.id === "api") {
			const availableApis = getProfileSelectableApis(profile, draft);
			const autoDraft = { ...draft, apiPreference: "auto" as const };
			const preference = await selectProfileApiPreference(
				ctx,
				`API: ${draft.id}`,
				draft.apiPreference,
				availableApis,
				formatProfileModelApi(profile, autoDraft),
				profile.apiRoutes === undefined,
			);
			if (preference !== undefined) draft = { ...draft, apiPreference: preference };
			continue;
		}
		if (result.item.id === "name") {
			const value = await promptText(ctx, "Model name", effectiveName);
			if (value !== undefined) {
				draft = { ...draft, overrides: { ...draft.overrides, name: value.trim() || effectiveName } };
			}
			continue;
		}
		if (result.item.id === "context") {
			const value = await promptPositiveInteger(ctx, "Context window", effectiveContextWindow);
			if (value !== undefined) {
				draft = { ...draft, overrides: { ...draft.overrides, contextWindow: value } };
			}
			continue;
		}
		if (result.item.id === "maxTokens") {
			const value = await promptPositiveInteger(ctx, "Max tokens", effectiveMaxTokens);
			if (value !== undefined) draft = { ...draft, overrides: { ...draft.overrides, maxTokens: value } };
		}
	}
}

// ============================================================================
// Shared helpers
// ============================================================================

async function selectProfileApiPreference(
	ctx: ExtensionCommandContext,
	title: string,
	current: ProfileApiPreference | undefined,
	availableApis: readonly RegistryApi[],
	autoDescription: string,
	includeAllInstalled = true,
): Promise<ProfileApiPreference | undefined> {
	const choices = buildApiPreferenceChoices(current, availableApis, autoDescription, includeAllInstalled);
	const selection = await selectOption(
		ctx,
		title,
		choices.map((choice) => choice.label),
	);
	return choices.find((choice) => choice.label === selection)?.value;
}

async function saveProfileToStore(
	ctx: ExtensionCommandContext,
	options: ProfileUiOptions,
	profile: Profile,
	isNew: boolean,
): Promise<void> {
	const next: Profile = {
		...profile,
		name: profile.name.trim() || profile.id,
		baseUrl: profile.baseUrl.trim(),
		authReference: {
			...profile.authReference,
			authProviderId: profile.authReference.authProviderId.trim() || profile.id,
		},
		updatedAt: new Date().toISOString(),
	};
	if (isNew) options.store.create(next);
	else options.store.update(next.id, () => next);
	await recompile(ctx, options);
	notify(ctx, `${isNew ? "Created" : "Saved"} profile: ${next.name}`, "info");
}

async function recompile(ctx: ExtensionCommandContext, options: ProfileUiOptions): Promise<void> {
	const diagnostics = compileAndWriteModelsJson(options.store, options.modelsJsonPath);
	reportDiagnostics(ctx, diagnostics);
	await options.refresh?.();
}

function reportDiagnostics(ctx: ExtensionCommandContext, diagnostics: readonly CompileDiagnostic[]): void {
	if (diagnostics.length === 0) return;
	const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	const lines = diagnostics
		.slice(0, 5)
		.map((diagnostic) => `${diagnostic.severity === "error" ? "Error" : "Warning"}: ${diagnostic.message}`);
	if (diagnostics.length > 5) lines.push(`... and ${diagnostics.length - 5} more`);
	notify(ctx, lines.join("\n"), errors.length > 0 ? "error" : "warning");
}
