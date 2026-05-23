import {
  resolveProviderSyntheticAuthWithPlugin,
  resolveProviderSyntheticAuthWithPluginAsync,
} from "../plugins/provider-runtime.js";
import {
  resolveRuntimeSyntheticAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefsAsync,
} from "../plugins/synthetic-auth.runtime.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  loadAuthProfileStoreForSecretsRuntime,
} from "./auth-profiles/store.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";
import { addEnvBackedPiCredentials } from "./pi-auth-discovery-core.js";

export type DiscoverAuthStorageOptions = {
  readOnly?: boolean;
};

export function resolvePiCredentialsForDiscovery(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): PiCredentialMap {
  const store =
    options?.readOnly === true
      ? loadAuthProfileStoreForSecretsRuntime(agentDir)
      : ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(store));
  for (const provider of resolveRuntimeSyntheticAuthProviderRefs()) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = resolveProviderSyntheticAuthWithPlugin({
      provider,
      context: {
        config: undefined,
        provider,
        providerConfig: undefined,
      },
    });
    const apiKey = resolved?.apiKey?.trim();
    if (!apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: apiKey,
    };
  }
  return credentials;
}

export async function resolvePiCredentialsForDiscoveryAsync(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): Promise<PiCredentialMap> {
  const store =
    options?.readOnly === true
      ? loadAuthProfileStoreForSecretsRuntime(agentDir)
      : await ensureAuthProfileStoreAsync(agentDir, { allowKeychainPrompt: false });
  const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(store));
  for (const provider of await resolveRuntimeSyntheticAuthProviderRefsAsync()) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = await resolveProviderSyntheticAuthWithPluginAsync({
      provider,
      context: {
        config: undefined,
        provider,
        providerConfig: undefined,
      },
    });
    const apiKey = resolved?.apiKey?.trim();
    if (!apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: apiKey,
    };
  }
  return credentials;
}

export {
  addEnvBackedPiCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscoveryAsync,
} from "./pi-auth-discovery-core.js";
