// Compat stub: branch's manifest-registry.ts imports clearPluginManifestRegistryCache /
// pluginManifestRegistryCache from this module. Upstream removed/renamed it during the
// 2026-04-26 plugin runtime refactor.
export const pluginManifestRegistryCache = new Map<string, unknown>();

export function clearPluginManifestRegistryCache(): void {
  pluginManifestRegistryCache.clear();
}
