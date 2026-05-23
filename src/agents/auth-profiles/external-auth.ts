import type { ProviderExternalAuthProfile } from "../../plugins/provider-external-auth.types.js";
import {
  resolveExternalAuthProfilesWithPlugins,
  resolveExternalAuthProfilesWithPluginsAsync,
} from "../../plugins/provider-runtime.js";
import * as externalCliSync from "./external-cli-sync.js";
import {
  overlayRuntimeExternalOAuthProfiles,
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;
type ResolveExternalAuthProfilesAsync = typeof resolveExternalAuthProfilesWithPluginsAsync;

let resolveExternalAuthProfilesForRuntime: ResolveExternalAuthProfiles | undefined;
let resolveExternalAuthProfilesForRuntimeAsync: ResolveExternalAuthProfilesAsync | undefined;

export const __testing = {
  resetResolveExternalAuthProfilesForTest(): void {
    resolveExternalAuthProfilesForRuntime = undefined;
    resolveExternalAuthProfilesForRuntimeAsync = undefined;
  },
  setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void {
    resolveExternalAuthProfilesForRuntime = resolver;
  },
  setResolveExternalAuthProfilesForTestAsync(resolver: ResolveExternalAuthProfilesAsync): void {
    resolveExternalAuthProfilesForRuntimeAsync = resolver;
  },
};

function normalizeExternalAuthProfile(
  profile: ProviderExternalAuthProfile,
): ProviderExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
  };
}

export function resolveExternalAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ExternalAuthProfileMap {
  const env = params.env ?? process.env;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
  const profiles = resolveProfiles({
    env,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalAuthProfileMap = new Map();
  const cliProfiles = externalCliSync.resolveExternalCliAuthProfiles?.(params.store) ?? [];
  for (const profile of cliProfiles) {
    resolved.set(profile.profileId, {
      profileId: profile.profileId,
      credential: profile.credential,
      persistence: "runtime-only",
    });
  }
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

/** Alias for {@link resolveExternalAuthProfileMap} (returns the runtime external auth id → profile map). */
export function listRuntimeExternalAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ExternalAuthProfileMap {
  return resolveExternalAuthProfileMap(params);
}

export async function resolveExternalAuthProfileMapAsync(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalAuthProfileMap> {
  const env = params.env ?? process.env;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntimeAsync ?? resolveExternalAuthProfilesWithPluginsAsync;
  const profiles = await resolveProfiles({
    env,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalAuthProfileMap = new Map();
  const cliProfiles = externalCliSync.resolveExternalCliAuthProfiles?.(params.store) ?? [];
  for (const profile of cliProfiles) {
    resolved.set(profile.profileId, {
      profileId: profile.profileId,
      credential: profile.credential,
      persistence: "runtime-only",
    });
  }
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

export async function listRuntimeExternalAuthProfileMapAsync(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalAuthProfileMap> {
  return resolveExternalAuthProfileMapAsync(params);
}

function listRuntimeExternalAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeExternalOAuthProfile[] {
  return Array.from(
    resolveExternalAuthProfileMap({
      store: params.store,
      agentDir: params.agentDir,
      env: params.env,
    }).values(),
  );
}

export async function listRuntimeExternalAuthProfilesAsync(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeExternalOAuthProfile[]> {
  return Array.from(
    (
      await resolveExternalAuthProfileMapAsync({
        store: params.store,
        agentDir: params.agentDir,
        env: params.env,
      })
    ).values(),
  );
}

export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv },
): AuthProfileStore {
  const profiles = listRuntimeExternalAuthProfiles({
    store,
    agentDir: params?.agentDir,
    env: params?.env,
  });
  return overlayRuntimeExternalOAuthProfiles(store, profiles);
}

export async function overlayExternalAuthProfilesAsync(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv },
): Promise<AuthProfileStore> {
  const profiles = await listRuntimeExternalAuthProfilesAsync({
    store,
    agentDir: params?.agentDir,
    env: params?.env,
  });
  return overlayRuntimeExternalOAuthProfiles(store, profiles);
}

export function shouldPersistExternalAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const profiles = listRuntimeExternalAuthProfiles({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
  });
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles,
  });
}

export async function shouldPersistExternalAuthProfileAsync(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const profiles = await listRuntimeExternalAuthProfilesAsync({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
  });
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles,
  });
}

// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
