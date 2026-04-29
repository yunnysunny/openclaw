import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  normalizeProviderSpecificConfig,
  normalizeProviderSpecificConfigAsync,
  resolveProviderConfigApiKeyResolver,
  resolveProviderConfigApiKeyResolverAsync,
} from "./models-config.providers.policy.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveApiKeyFromProfilesAsync,
  resolveMissingProviderApiKey,
  resolveMissingProviderApiKeyAsync,
} from "./models-config.providers.secret-helpers.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceProviders?: ModelsConfig["providers"];
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const resolveProfileApiKey = (providerKey: string) => {
    authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    return resolveApiKeyFromProfiles({
      provider: providerKey,
      store: authStore,
      env,
    });
  };
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      mutated = true;
      continue;
    }
    if (normalizedKey !== key) {
      mutated = true;
    }
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
    });
    if (normalizedHeaders.mutated) {
      mutated = true;
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const providerWithConfiguredApiKey = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey: undefined,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithConfiguredApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithConfiguredApiKey;
    }

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    const providerWithResolvedEnvApiKey = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithResolvedEnvApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithResolvedEnvApiKey;
    }

    const needsProfileApiKey =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0 &&
      !(
        (typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim()) ||
        normalizedProvider.apiKey
      );
    const profileApiKey = needsProfileApiKey ? resolveProfileApiKey(normalizedKey) : undefined;
    const providerApiKeyResolver = needsProfileApiKey
      ? resolveProviderConfigApiKeyResolver(normalizedKey)
      : undefined;
    const providerWithApiKey = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver,
    });
    if (providerWithApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithApiKey;
    }

    const providerSpecificNormalized = normalizeProviderSpecificConfig(
      normalizedKey,
      normalizedProvider,
    );
    if (providerSpecificNormalized !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerSpecificNormalized;
    }

    const existing = next[normalizedKey];
    if (existing) {
      // Keep deterministic behavior if users accidentally define duplicate
      // provider keys that only differ by surrounding whitespace.
      mutated = true;
      next[normalizedKey] = {
        ...existing,
        ...normalizedProvider,
        models: normalizedProvider.models ?? existing.models,
      };
      continue;
    }
    next[normalizedKey] = normalizedProvider;
  }

  const normalizedProviders = mutated ? next : providers;
  return enforceSourceManagedProviderSecrets({
    providers: normalizedProviders,
    sourceProviders: params.sourceProviders,
    sourceSecretDefaults: params.sourceSecretDefaults,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}

/**
 * Async counterpart to {@link normalizeProviders}: same pipeline, but resolves
 * profile API keys with {@link resolveApiKeyFromProfilesAsync}.
 */
export async function normalizeProvidersAsync(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceProviders?: ModelsConfig["providers"];
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): Promise<ModelsConfig["providers"]> {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const profileApiKeyCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveApiKeyFromProfilesAsync>>
  >();
  const providerApiKeyResolverCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveProviderConfigApiKeyResolverAsync>>
  >();
  const resolveProfileApiKeyAsync = async (providerKey: string) => {
    const cached = profileApiKeyCache.get(providerKey);
    if (cached !== undefined) {
      return cached;
    }
    authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const resolved = await resolveApiKeyFromProfilesAsync({
      provider: providerKey,
      store: authStore,
      env,
    });
    profileApiKeyCache.set(providerKey, resolved);
    return resolved;
  };
  const resolveProviderApiKeyResolverAsync = async (providerKey: string) => {
    if (providerApiKeyResolverCache.has(providerKey)) {
      return providerApiKeyResolverCache.get(providerKey);
    }
    const resolved = await resolveProviderConfigApiKeyResolverAsync(providerKey);
    providerApiKeyResolverCache.set(providerKey, resolved);
    return resolved;
  };
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      mutated = true;
      continue;
    }
    if (normalizedKey !== key) {
      mutated = true;
    }
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
    });
    if (normalizedHeaders.mutated) {
      mutated = true;
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const providerWithConfiguredApiKey = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey: undefined,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithConfiguredApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithConfiguredApiKey;
    }

    const providerWithResolvedEnvApiKey = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithResolvedEnvApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithResolvedEnvApiKey;
    }

    const needsProfileApiKey =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0 &&
      !(
        (typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim()) ||
        normalizedProvider.apiKey
      );
    const profileApiKey = needsProfileApiKey
      ? await resolveProfileApiKeyAsync(normalizedKey)
      : undefined;
    const providerApiKeyResolver = needsProfileApiKey
      ? await resolveProviderApiKeyResolverAsync(normalizedKey)
      : undefined;
    const providerWithApiKey = await resolveMissingProviderApiKeyAsync({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver,
    });
    if (providerWithApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithApiKey;
    }

    const providerSpecificNormalized = await normalizeProviderSpecificConfigAsync(
      normalizedKey,
      normalizedProvider,
    );
    if (providerSpecificNormalized !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerSpecificNormalized;
    }

    const existing = next[normalizedKey];
    if (existing) {
      mutated = true;
      next[normalizedKey] = {
        ...existing,
        ...normalizedProvider,
        models: normalizedProvider.models ?? existing.models,
      };
      continue;
    }
    next[normalizedKey] = normalizedProvider;
  }

  const normalizedProviders = mutated ? next : providers;
  return enforceSourceManagedProviderSecrets({
    providers: normalizedProviders,
    sourceProviders: params.sourceProviders,
    sourceSecretDefaults: params.sourceSecretDefaults,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}
