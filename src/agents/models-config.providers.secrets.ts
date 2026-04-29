import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderSyntheticAuthWithPluginAsync } from "../plugins/provider-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import {
  listAuthProfilesForProvider,
  listAuthProfilesForProviderAsync,
  resolveApiKeyFromCredentialAsync,
  resolveApiKeyFromProfilesAsync,
  resolveEnvApiKeyVarNameAsync,
  toDiscoveryApiKey,
  type ProviderApiKeyResolver,
  type ProviderAuthResolver,
} from "./models-config.providers.secret-helpers.js";
import { resolveProviderIdForAuthAsync } from "./provider-auth-aliases.js";

export type {
  ProfileApiKeyResolution,
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
  SecretDefaults,
} from "./models-config.providers.secret-helpers.js";

export {
  listAuthProfilesForProvider,
  listAuthProfilesForProviderAsync,
  normalizeApiKeyConfig,
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  normalizeResolvedEnvApiKeyAsync,
  resolveApiKeyFromCredential,
  resolveApiKeyFromCredentialAsync,
  resolveApiKeyFromProfiles,
  resolveApiKeyFromProfilesAsync,
  resolveAwsSdkApiKeyVarName,
  resolveEnvApiKeyVarName,
  resolveEnvApiKeyVarNameAsync,
  resolveMissingProviderApiKey,
  resolveMissingProviderApiKeyAsync,
  toDiscoveryApiKey,
} from "./models-config.providers.secret-helpers.js";

type AuthProfileStoreInput = AuthProfileStore | (() => AuthProfileStore);

function resolveAuthProfileStoreInput(input: AuthProfileStoreInput) {
  return typeof input === "function" ? input() : input;
}

export function createProviderApiKeyResolver(
  env: NodeJS.ProcessEnv,
  authStoreInput: AuthProfileStoreInput,
  config?: OpenClawConfig,
): ProviderApiKeyResolver {
  return async (
    provider: string,
  ): Promise<{ apiKey: string | undefined; discoveryApiKey?: string }> => {
    const authProvider = await resolveProviderIdForAuthAsync(provider, { config, env });
    const envVar = await resolveEnvApiKeyVarNameAsync(authProvider, env);
    if (envVar) {
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
      };
    }
    const fromConfig = await resolveConfigBackedProviderAuthAsync({
      provider: authProvider,
      config,
      env,
    });
    if (fromConfig?.apiKey) {
      return {
        apiKey: fromConfig.apiKey,
        discoveryApiKey: fromConfig.discoveryApiKey,
      };
    }
    const fromProfiles = await resolveApiKeyFromProfilesAsync({
      provider: authProvider,
      store: resolveAuthProfileStoreInput(authStoreInput),
      env,
    });
    return fromProfiles?.apiKey
      ? {
          apiKey: fromProfiles.apiKey,
          discoveryApiKey: fromProfiles.discoveryApiKey,
        }
      : { apiKey: undefined, discoveryApiKey: undefined };
  };
}

export function createProviderAuthResolver(
  env: NodeJS.ProcessEnv,
  authStoreInput: AuthProfileStoreInput,
  config?: OpenClawConfig,
): ProviderAuthResolver {
  return async (provider: string, options?: { oauthMarker?: string }) => {
    const authProvider = await resolveProviderIdForAuthAsync(provider, { config, env });
    const authStore = resolveAuthProfileStoreInput(authStoreInput);
    const ids = listAuthProfilesForProvider(authStore, authProvider);

    let oauthCandidate:
      | {
          apiKey: string | undefined;
          discoveryApiKey?: string;
          mode: "oauth";
          source: "profile";
          profileId: string;
        }
      | undefined;
    for (const id of ids) {
      const cred = authStore.profiles[id];
      if (!cred) {
        continue;
      }
      if (cred.type === "oauth") {
        oauthCandidate ??= {
          apiKey: options?.oauthMarker,
          discoveryApiKey: toDiscoveryApiKey(cred.access),
          mode: "oauth",
          source: "profile",
          profileId: id,
        };
        continue;
      }
      const resolved = await resolveApiKeyFromCredentialAsync(cred, env);
      if (!resolved) {
        continue;
      }
      return {
        apiKey: resolved.apiKey,
        discoveryApiKey: resolved.discoveryApiKey,
        mode: cred.type,
        source: "profile" as const,
        profileId: id,
      };
    }
    if (oauthCandidate) {
      return oauthCandidate;
    }

    const envVar = await resolveEnvApiKeyVarNameAsync(authProvider, env);
    if (envVar) {
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        mode: "api_key" as const,
        source: "env" as const,
      };
    }

    const fromConfig = await resolveConfigBackedProviderAuthAsync({
      provider: authProvider,
      config,
      env,
    });
    if (fromConfig) {
      return {
        apiKey: fromConfig.apiKey,
        discoveryApiKey: fromConfig.discoveryApiKey,
        mode: fromConfig.mode,
        source: "none",
      };
    }
    return {
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    };
  };
}

async function resolveConfigBackedProviderAuthAsync(params: {
  provider: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<
  | {
      apiKey: string;
      discoveryApiKey?: string;
      mode: "api_key";
      source: "config";
    }
  | undefined
> {
  const authProvider = await resolveProviderIdForAuthAsync(params.provider, {
    config: params.config,
    env: params.env,
  });
  const synthetic = await resolveProviderSyntheticAuthWithPluginAsync({
    provider: authProvider,
    config: params.config,
    context: {
      config: params.config,
      provider: authProvider,
      providerConfig: params.config?.models?.providers?.[authProvider],
    },
  });
  const apiKey = synthetic?.apiKey?.trim();
  if (!apiKey) {
    return undefined;
  }
  return isNonSecretApiKeyMarker(apiKey)
    ? {
        apiKey,
        discoveryApiKey: toDiscoveryApiKey(apiKey),
        mode: "api_key",
        source: "config",
      }
    : {
        apiKey: resolveNonEnvSecretRefApiKeyMarker("file"),
        discoveryApiKey: toDiscoveryApiKey(apiKey),
        mode: "api_key",
        source: "config",
      };
}
