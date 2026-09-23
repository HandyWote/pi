/** pi-profile extension entry: registers the /profile command. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProfileCommand } from "./command.ts";
import { ProfilesStore } from "./profiles-store.ts";

export const PI_PROFILE_EXTENSION_NAME = "pi-profile";

export default function piProfile(pi: ExtensionAPI): void {
	const store = new ProfilesStore();
	registerProfileCommand(pi, store);
}

export {
	atomicWriteFileSync,
	readTextFileIfExists,
} from "./atomic-write.ts";
export {
	compileProfiles,
	mergeIntoModelsJson,
	normalizeBaseUrl,
	selectModelApi,
	serializeModelsJson,
} from "./compiler.ts";
export { compileAndWriteModelsJson, getModelsJsonPath, toCompilerProfileInput } from "./profile-manager.ts";
export type { ProfilesStateFile } from "./profiles-state-file.ts";
export { getProfileStatePath, ProfilesStore } from "./profiles-store.ts";
export type { Profile, ProfileApiRoute, ProfileAuthReference, UserModel } from "./profiles-types.ts";
