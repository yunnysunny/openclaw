import { resolveProviderConfigApiKeyWithPluginAsync } from "../plugins/provider-runtime.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import {
  applyProviderNativeStreamingUsagePolicy,
  normalizeProviderConfigPolicy,
  normalizeProviderConfigPolicyAsync,
  resolveProviderConfigApiKeyPolicy,
} from "./models-config.providers.policy.runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const nextProvider = applyProviderNativeStreamingUsagePolicy(providerKey, provider);
    nextProviders[providerKey] = nextProvider;
    changed ||= nextProvider !== provider;
  }

  return changed ? nextProviders : providers;
}

export function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  const normalized = normalizeProviderConfigPolicy(providerKey, provider);
  if (normalized && normalized !== provider) {
    return normalized;
  }
  return provider;
}

/**
 * Async counterpart to {@link normalizeProviderSpecificConfig} for
 * {@link normalizeProvidersAsync} and other async config pipelines.
 */
export async function normalizeProviderSpecificConfigAsync(
  providerKey: string,
  provider: ProviderConfig,
): Promise<ProviderConfig> {
  const normalized = await normalizeProviderConfigPolicyAsync(providerKey, provider);
  if (normalized && normalized !== provider) {
    return normalized;
  }
  return provider;
}

export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
  provider?: ProviderConfig,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  return resolveProviderConfigApiKeyPolicy(providerKey, provider);
}

export async function resolveProviderConfigApiKeyResolverAsync(
  providerKey: string,
  provider?: ProviderConfig,
): Promise<
  ((env: NodeJS.ProcessEnv) => string | undefined | Promise<string | undefined>) | undefined
> {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
  return async (env) =>
    resolveProviderConfigApiKeyWithPluginAsync({
      provider: runtimeProviderKey,
      context: {
        provider: providerKey,
        env,
      },
    });
}
