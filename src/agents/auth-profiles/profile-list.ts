import {
  resolveProviderIdForAuth,
  resolveProviderIdForAuthAsync,
} from "../provider-auth-aliases.js";
import type { AuthProfileStore } from "./types.js";

export function dedupeProfileIds(profileIds: string[]): string[] {
  return [...new Set(profileIds)];
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}

export async function listProfilesForProviderAsync(
  store: AuthProfileStore,
  provider: string,
): Promise<string[]> {
  const providerKey = await resolveProviderIdForAuthAsync(provider);
  const ids: string[] = [];
  for (const [id, cred] of Object.entries(store.profiles)) {
    if ((await resolveProviderIdForAuthAsync(cred.provider)) === providerKey) {
      ids.push(id);
    }
  }
  return ids;
}
