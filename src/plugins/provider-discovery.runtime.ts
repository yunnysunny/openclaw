import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import {
  loadPluginManifestRegistryAsync,
  loadPluginManifestRegistrySync,
} from "./manifest-registry.js";
import {
  resolveDiscoveredProviderPluginIds,
  resolveDiscoveredProviderPluginIdsAsync,
} from "./providers.js";
import { resolvePluginProviders, resolvePluginProvidersAsync } from "./providers.runtime.js";
import { createPluginSourceLoader } from "./source-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderDiscoveryModule =
  | ProviderPlugin
  | ProviderPlugin[]
  | {
      default?: ProviderPlugin | ProviderPlugin[];
      providers?: ProviderPlugin[];
      provider?: ProviderPlugin;
    };

function normalizeDiscoveryModule(value: ProviderDiscoveryModule): ProviderPlugin[] {
  const resolved =
    value && typeof value === "object" && "default" in value && value.default !== undefined
      ? value.default
      : value;
  if (Array.isArray(resolved)) {
    return resolved;
  }
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return [resolved];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { providers?: ProviderPlugin[]; provider?: ProviderPlugin };
    if (Array.isArray(record.providers)) {
      return record.providers;
    }
    if (record.provider) {
      return [record.provider];
    }
  }
  return [];
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const pluginIds = resolveDiscoveredProviderPluginIds(params);
  const pluginIdSet = new Set(pluginIds);
  const records = loadPluginManifestRegistrySync(params).plugins.filter(
    (plugin) => plugin.providerDiscoverySource && pluginIdSet.has(plugin.id),
  );
  if (records.length === 0) {
    return [];
  }
  const jitiCache: PluginJitiLoaderCache = new Map();
  const providers: ProviderPlugin[] = [];
  for (const manifest of records) {
    try {
      const modPath = manifest.providerDiscoverySource!;
      const jiti = getCachedPluginJitiLoader({
        cache: jitiCache,
        modulePath: modPath,
        importerUrl: import.meta.url,
        jitiFilename: import.meta.url,
      });
      const moduleExport = jiti(modPath) as ProviderDiscoveryModule;
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      // Discovery fast path is optional. Fall back to the full plugin loader
      // below so existing plugin diagnostics/load behavior remains canonical.
      return [];
    }
  }
  return providers;
}

async function resolveProviderDiscoveryEntryPluginsAsync(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): Promise<ProviderPlugin[]> {
  const pluginIds = await resolveDiscoveredProviderPluginIdsAsync(params);
  const pluginIdSet = new Set(pluginIds);
  const records = (await loadPluginManifestRegistryAsync(params)).plugins.filter(
    (plugin) => plugin.providerDiscoverySource && pluginIdSet.has(plugin.id),
  );
  if (records.length === 0) {
    return [];
  }
  const loadSource = createPluginSourceLoader();
  const providers: ProviderPlugin[] = [];
  for (const manifest of records) {
    try {
      const moduleExport = (await loadSource(
        manifest.providerDiscoverySource!,
      )) as ProviderDiscoveryModule;
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      return [];
    }
  }
  return providers;
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const entryProviders = resolveProviderDiscoveryEntryPlugins(params);
  if (entryProviders.length > 0) {
    return entryProviders;
  }
  return resolvePluginProviders({
    ...params,
    bundledProviderAllowlistCompat: true,
  });
}

/**
 * Async counterpart to {@link resolvePluginDiscoveryProvidersRuntime}: awaitable
 * manifest and full provider loader paths.
 */
export async function resolvePluginDiscoveryProvidersRuntimeAsync(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): Promise<ProviderPlugin[]> {
  const entryProviders = await resolveProviderDiscoveryEntryPluginsAsync(params);
  if (entryProviders.length > 0) {
    return entryProviders;
  }
  return resolvePluginProvidersAsync({
    ...params,
    bundledProviderAllowlistCompat: true,
  });
}
