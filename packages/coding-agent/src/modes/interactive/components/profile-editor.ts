import { enrichWithModelsDev, fetchModelsFromEndpoint } from "../../../core/model-metadata.ts";
import type { Profile, ProfileProtocol, UserModel } from "../../../core/profiles-types.ts";

export interface ProfileEditorCallbacks {
	onSave: (profile: Profile) => void;
	onCancel: () => void;
}

export class ProfileEditorComponent {
	name = "";
	protocol: ProfileProtocol = "openai";
	baseUrl = "";
	apiKey = "";
	models: UserModel[] = [];
	status = "";
	loading = false;
	editingProfileId?: string;

	constructor(callbacks: ProfileEditorCallbacks, existing?: Profile) {
		if (existing) {
			this.editingProfileId = existing.id;
			this.name = existing.name;
			this.protocol = existing.protocol;
			this.baseUrl = existing.baseUrl;
			this.apiKey = existing.apiKey;
			this.models = existing.models;
		}
		// callbacks stored by the caller (InteractiveMode)
		void callbacks;
	}

	render(): string {
		const lines = [this.editingProfileId ? "Edit Profile" : "Create Profile", ""];
		lines.push(`  Name:     [${this.name}]`);
		lines.push(`  Protocol: [${this.protocol}]`);
		lines.push(`  Base URL: [${this.baseUrl}]`);
		lines.push(`  API Key:  [${this.apiKey ? "••••••••" : ""}]`);
		lines.push("");
		const enabledCount = this.models.filter((m) => m.enabled).length;
		lines.push(`  Models: ${this.models.length} loaded, ${enabledCount} enabled`);
		if (this.loading) lines.push("  Fetching models...");
		if (this.status) lines.push(`  ${this.status}`);
		lines.push("");
		lines.push("  [f] Fetch models  [s] Save  [q] Cancel");
		return lines.join("\n");
	}

	async fetchModels(): Promise<void> {
		this.loading = true;
		this.status = "Fetching models from endpoint...";
		try {
			const tempProfile: Profile = {
				id: this.editingProfileId ?? "",
				name: this.name,
				protocol: this.protocol,
				baseUrl: this.baseUrl,
				apiKey: this.apiKey,
				models: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			if (this.protocol === "openai") {
				const fetchedModels = await fetchModelsFromEndpoint(tempProfile);
				this.models = await enrichWithModelsDev(fetchedModels);
				this.status = `Loaded ${this.models.length} models`;
			} else {
				this.status = "Anthropic protocol: enter model IDs manually";
			}
		} catch (error) {
			this.status = `Error: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.loading = false;
		}
	}

	toProfile(): Profile {
		const now = new Date().toISOString();
		return {
			id: this.editingProfileId ?? crypto.randomUUID(),
			name: this.name,
			protocol: this.protocol,
			baseUrl: this.baseUrl,
			apiKey: this.apiKey,
			models: this.models,
			createdAt: new Date().toISOString(),
			updatedAt: now,
		};
	}
}
