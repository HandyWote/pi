/** Profile management state file schema (the profile source of truth). */

import type { Profile } from "./profiles-types.ts";

export interface ProfilesStateFile {
	version: 1;
	/** Profiles keyed by their stable profile ID (runtime provider ID). */
	profiles: Record<string, Profile>;
	/**
	 * Provider IDs the profile compiler wrote into models.json on the last
	 * compile. Used to remove stale generated providers when a profile is
	 * deleted or stops producing models, without deleting user-owned providers.
	 */
	managedProviderIds?: string[];
}
