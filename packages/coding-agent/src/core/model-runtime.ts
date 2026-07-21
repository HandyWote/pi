import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import { createProfileProvider } from "./profile-runtime.ts";
import { ProfilesStore } from "./profiles-store.ts";
import type { Profile } from "./profiles-types.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	credentials?: CredentialStore;
	authPath?: string;
	profilesPath?: string;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** @deprecated Use profiles instead. */
	modelsPath?: string | null;
	/** @deprecated No-op in profile mode. */
	allowModelNetwork?: boolean;
	/** @deprecated No-op in profile mode. */
	catalogBaseUrl?: string;
	/** @deprecated No-op in profile mode. */
	modelRefreshTimeoutMs?: number;
}

export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly profilesStore: ProfilesStore;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefresh: Promise<void> | undefined;
	private availabilityError: string | undefined;

	private constructor(credentials: RuntimeCredentials, profilesStore: ProfilesStore, modelsStore: ModelsStore) {
		this.credentials = credentials;
		this.profilesStore = profilesStore;
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const profilesStore = new ProfilesStore(options.profilesPath);
		const modelsStore =
			options.modelsStore ??
			(options.modelsStorePath
				? new FileModelsStore(options.modelsStorePath)
				: new InMemoryCodingAgentModelsStore());
		const runtime = new ModelRuntime(credentials, profilesStore, modelsStore);
		await runtime.forceRefreshAvailability();
		return runtime;
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		const profiles = this.profilesStore.list();
		for (const profile of profiles) {
			try {
				const provider = createProfileProvider(profile);
				this.models.setProvider(provider);
			} catch {
				// Skip broken profiles; error is available via getError()
			}
		}
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(): Promise<void> {
		const providers = this.models.getProviders();
		const profiles = this.profilesStore.list();
		const profileIds = new Set(profiles.map((p) => p.id));

		const configuredProviders = new Set<string>();
		const auth = new Map<string, AuthCheck | undefined>();

		// All loaded profiles are "configured" since they include apiKey
		for (const profileId of profileIds) {
			configuredProviders.add(profileId);
			auth.set(profileId, { type: "api_key", source: "profile" });
		}

		// Also check providers that may not have profiles (extension providers)
		for (const provider of providers) {
			if (!profileIds.has(provider.id)) {
				try {
					const check = await this.models.checkAuth(provider.id);
					auth.set(provider.id, check);
					if (check) configuredProviders.add(provider.id);
				} catch {
					auth.set(provider.id, undefined);
				}
			}
		}

		const [available, credentials] = await Promise.all([this.models.getAvailable(), this.credentials.list()]);

		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(after: Promise<void> | undefined): Promise<void> {
		const refresh = (after ?? Promise.resolve()).catch(() => {}).then(() => this.runAvailabilityRefresh());
		const recorded = refresh.catch((error) => {
			this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}

	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh(undefined);
	}

	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh(this.availabilityRefresh);
	}

	// Profile management

	getProfiles(): readonly Profile[] {
		return this.profilesStore.list();
	}

	getProfile(id: string): Profile | undefined {
		return this.profilesStore.get(id);
	}

	async createProfile(profile: Profile): Promise<void> {
		this.profilesStore.create(profile);
		this.rebuildProviders();
		await this.runAvailabilityRefresh();
	}

	async updateProfile(id: string, fn: (p: Profile) => Profile): Promise<void> {
		this.profilesStore.update(id, fn);
		this.rebuildProviders();
		await this.runAvailabilityRefresh();
	}

	async deleteProfile(id: string): Promise<void> {
		this.profilesStore.delete(id);
		this.rebuildProviders();
		await this.runAvailabilityRefresh();
	}

	setActiveProfile(id: string | undefined): void {
		this.profilesStore.setActive(id);
	}

	getActiveProfile(): Profile | undefined {
		return this.profilesStore.getActive();
	}

	// Models interface

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		if (this.availabilityError) return `Availability refresh: ${this.availabilityError}`;
		return undefined;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getProviderAuthStatus(providerId: string): {
		configured: boolean;
		source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
		label?: string;
	} {
		if (this.snapshot.configuredProviders.has(providerId)) {
			return { configured: true, source: "stored" };
		}
		return { configured: false };
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		return this.models.getAuth(providerOrModel, overrides);
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		return this.models.login(providerId, type, interaction);
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		await this.refresh({ allowNetwork: false });
	}

	async reloadConfig(): Promise<void> {
		this.rebuildProviders();
		await this.refresh({ allowNetwork: false });
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const result = ((await this.models.refresh(options)) as ModelsRefreshResult | undefined) ?? {
			aborted: options.signal?.aborted ?? false,
			errors: new Map(),
		};
		this.updateModelSnapshot();
		try {
			await this.forceRefreshAvailability();
		} catch {
			// Availability errors are recorded; models remain usable.
		}
		return result;
	}

	// Extension support — kept for backward compatibility

	registerNativeProvider(provider: Provider): void {
		this.models.setProvider(provider);
		this.updateModelSnapshot();
		void this.runAvailabilityRefresh();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	registerProvider(_providerId: string, _config: any): void {
		// No-op: profiles replace extension provider config
	}

	unregisterProvider(providerId: string): void {
		this.models.deleteProvider(providerId);
		this.updateModelSnapshot();
		void this.runAvailabilityRefresh();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getRegisteredProviderConfig(_providerId: string): any {
		return undefined;
	}

	getRegisteredProviderIds(): readonly string[] {
		return [];
	}

	getRegisteredNativeProvider(_providerId: string): Provider | undefined {
		return undefined;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getCompatibilityRequestConfig(_model: Model<Api>): any {
		return {};
	}

	async setRuntimeApiKey(
		providerId: string,
		apiKey: string,
		refreshOptions: ModelsRefreshOptions = {},
	): Promise<void> {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		await this.runAvailabilityRefresh();
		if (refreshOptions.allowNetwork) await this.refresh(refreshOptions);
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.runAvailabilityRefresh();
	}

	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}
