import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginManifestRegistryAsync } from "./manifest-registry.js";
import { loadPluginManifestRegistrySync } from "./manifest-registry.js";
import { getPluginRegistryState } from "./runtime-state.js";

function uniqueProviderRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const normalized = normalizeProviderId(trimmed);
    if (!trimmed || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(trimmed);
  }
  return next;
}

function resolveManifestSyntheticAuthProviderRefs(): string[] {
  return uniqueProviderRefs(
    loadPluginManifestRegistrySync({ cache: true }).plugins.flatMap(
      (plugin) => plugin.syntheticAuthRefs ?? [],
    ),
  );
}

async function resolveManifestSyntheticAuthProviderRefsAsync(): Promise<string[]> {
  const registry = await loadPluginManifestRegistryAsync({ cache: true });
  return uniqueProviderRefs(registry.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []));
}

export function resolveRuntimeSyntheticAuthProviderRefs(): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
      ...(registry.providers ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.provider &&
            typeof entry.provider.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.provider.id),
      ...(registry.cliBackends ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.backend &&
            typeof entry.backend.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.backend.id),
    ]);
  }
  return resolveManifestSyntheticAuthProviderRefs();
}

export async function resolveRuntimeSyntheticAuthProviderRefsAsync(): Promise<string[]> {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
      ...(registry.providers ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.provider &&
            typeof entry.provider.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.provider.id),
      ...(registry.cliBackends ?? [])
        .filter(
          (entry) =>
            "resolveSyntheticAuth" in entry.backend &&
            typeof entry.backend.resolveSyntheticAuth === "function",
        )
        .map((entry) => entry.backend.id),
    ]);
  }
  return resolveManifestSyntheticAuthProviderRefsAsync();
}
