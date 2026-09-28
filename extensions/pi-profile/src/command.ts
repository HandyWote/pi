/** Minimal /profile command: list and create profiles against the store. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CompileDiagnostic, isValidProviderId } from "./compiler.ts";
import { compileAndWriteModelsJson } from "./profile-manager.ts";
import type { ProfilesStore } from "./profiles-store.ts";
import type { Profile } from "./profiles-types.ts";
import { runProfileUi } from "./ui/profile-ui.ts";

function formatProfileLine(profile: Profile): string {
	const enabled = profile.models.filter((model) => model.enabled).length;
	return `${profile.id} — ${profile.name} · ${enabled}/${profile.models.length} enabled · ${profile.baseUrl}`;
}

/**
 * Build a minimal profile draft. The auth.json provider id is also the
 * profile's stable runtime provider id: models.json credentials are keyed by
 * provider ID, so the two must match for the credential to resolve.
 */
export function createProfileDraft(name: string, baseUrl: string, authProviderId: string): Profile {
	if (!isValidProviderId(authProviderId)) {
		throw new Error(
			`Invalid auth provider id "${authProviderId}": it becomes the stable models.json provider id and must be non-empty without whitespace or "/"`,
		);
	}
	const now = new Date().toISOString();
	return {
		id: authProviderId,
		name,
		baseUrl,
		authReference: { authProviderId },
		models: [],
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Save a profile (create or update) and recompile models.json. Returns
 * compiler diagnostics for the caller to surface.
 */
export function saveProfile(
	store: ProfilesStore,
	profile: Profile,
	modelsJsonPath?: string,
): { profile: Profile; diagnostics: CompileDiagnostic[] } {
	const existing = store.get(profile.id);
	const next: Profile = { ...profile, updatedAt: new Date().toISOString() };
	const saved = existing ? store.update(profile.id, () => next) : store.create(next);
	const diagnostics = compileAndWriteModelsJson(store, modelsJsonPath);
	return { profile: saved, diagnostics };
}

export function registerProfileCommand(pi: ExtensionAPI, store: ProfilesStore): void {
	pi.registerCommand("profile", {
		description: "Manage gateway profiles: /profile [create <name> <baseUrl> <authProviderId>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const input = args.trim();

			if (!input && ctx.mode === "tui") {
				await runProfileUi(ctx, {
					store,
					refresh: async () => {
						await ctx.modelRegistry.refresh();
					},
				});
				return;
			}

			if (!input) {
				const profiles = store.list();
				if (profiles.length === 0) {
					ctx.ui.notify("No profiles. Use: /profile create <name> <baseUrl> <authProviderId>", "info");
					return;
				}
				ctx.ui.notify(profiles.map((profile) => formatProfileLine(profile)).join("\n"), "info");
				return;
			}

			const [action, ...rest] = input.split(/\s+/);
			if (action !== "create") {
				ctx.ui.notify("Usage: /profile create <name> <baseUrl> <authProviderId>", "error");
				return;
			}
			const [name, baseUrl, authProviderId] = rest;
			if (!name || !baseUrl || !authProviderId) {
				ctx.ui.notify("Usage: /profile create <name> <baseUrl> <authProviderId>", "error");
				return;
			}
			try {
				const draft = createProfileDraft(name, baseUrl, authProviderId);
				const { profile, diagnostics } = saveProfile(store, draft);
				const warning =
					diagnostics.length > 0
						? ` (${diagnostics.length} compiler diagnostic${diagnostics.length === 1 ? "" : "s"})`
						: "";
				ctx.ui.notify(`Created profile: ${profile.id} — compiled to models.json${warning}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
