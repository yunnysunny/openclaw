import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  resolveManifestActivationPluginIds,
  resolveManifestActivationPluginIdsAsync,
} from "./activation-planner.js";
import {
  createPluginActivationSource,
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import {
  loadPluginManifestRegistryAsync,
  loadPluginManifestRegistrySync,
  type PluginManifestRecord,
} from "./manifest-registry.js";
import { hasKind } from "./slots.js";

function hasRuntimeContractSurface(plugin: PluginManifestRecord): boolean {
  return Boolean(
    plugin.providers.length > 0 ||
    plugin.cliBackends.length > 0 ||
    plugin.contracts?.speechProviders?.length ||
    plugin.contracts?.mediaUnderstandingProviders?.length ||
    plugin.contracts?.imageGenerationProviders?.length ||
    plugin.contracts?.videoGenerationProviders?.length ||
    plugin.contracts?.musicGenerationProviders?.length ||
    plugin.contracts?.webFetchProviders?.length ||
    plugin.contracts?.webSearchProviders?.length ||
    plugin.contracts?.memoryEmbeddingProviders?.length ||
    hasKind(plugin.kind, "memory"),
  );
}

function isGatewayStartupMemoryPlugin(plugin: PluginManifestRecord): boolean {
  return hasKind(plugin.kind, "memory");
}

function isGatewayStartupSidecar(plugin: PluginManifestRecord): boolean {
  return plugin.channels.length === 0 && !hasRuntimeContractSurface(plugin);
}

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function normalizeChannelIds(channelIds: Iterable<string>): string[] {
  return Array.from(
    new Set(
      [...channelIds]
        .map((channelId) => normalizeOptionalLowercaseString(channelId))
        .filter((channelId): channelId is string => Boolean(channelId)),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
}

function isChannelPluginEligibleForScopedOwnership(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig: OpenClawConfig;
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.plugin)) {
    return true;
  }
  if (params.plugin.origin === "global" || params.plugin.origin === "config") {
    return hasExplicitManifestOwnerTrust({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    });
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

function resolveScopedChannelOwnerPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  const channelIds = normalizeChannelIds(params.channelIds);
  if (channelIds.length === 0) {
    return [];
  }
  const registry = loadPluginManifestRegistrySync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  });
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const candidateIds = dedupeSortedPluginIds(
    channelIds.flatMap((channelId) => {
      return resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: channelId,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
      });
    }),
  );
  if (candidateIds.length === 0) {
    return [];
  }
  const candidateIdSet = new Set(candidateIds);
  return registry.plugins
    .filter((plugin) => {
      if (!candidateIdSet.has(plugin.id)) {
        return false;
      }
      return isChannelPluginEligibleForScopedOwnership({
        plugin,
        normalizedConfig,
        rootConfig: trustConfig,
      });
    })
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

export function resolveDiscoverableScopedChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  return resolveScopedChannelOwnerPluginIds(params);
}

function resolveGatewayStartupDreamingPluginIds(config: OpenClawConfig): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return new Set();
  }
  return new Set(["memory-core", resolveMemoryDreamingPluginId(config)]);
}

function resolveExplicitMemorySlotStartupPluginId(config: OpenClawConfig): string | undefined {
  const configuredSlot = config.plugins?.slots?.memory?.trim();
  if (!configuredSlot || configuredSlot.toLowerCase() === "none") {
    return undefined;
  }
  return normalizePluginId(configuredSlot);
}

function shouldConsiderForGatewayStartup(params: {
  plugin: PluginManifestRecord;
  startupDreamingPluginIds: ReadonlySet<string>;
  explicitMemorySlotStartupPluginId?: string;
}): boolean {
  if (isGatewayStartupSidecar(params.plugin)) {
    return true;
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.id)) {
    return true;
  }
  return params.explicitMemorySlotStartupPluginId === params.plugin.id;
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return loadPluginManifestRegistrySync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredChannelPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return resolveScopedChannelPluginIds({
    ...params,
    channelIds: [...configuredChannelIds],
  });
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return loadPluginManifestRegistrySync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.channels.some((channelId) => configuredChannelIds.has(channelId)) &&
        plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
    )
    .map((plugin) => plugin.id);
}

function listGatewayStartupPluginIdsFromManifestPlugins(params: {
  rootConfig: OpenClawConfig;
  manifestPlugins: readonly PluginManifestRecord[];
  configuredChannelIds: Set<string>;
  pluginsConfig: ReturnType<typeof normalizePluginsConfig>;
  activationSource: ReturnType<typeof createPluginActivationSource>;
  requiredAgentHarnessPluginIds: Set<string>;
  startupDreamingPluginIds: ReadonlySet<string>;
  explicitMemorySlotStartupPluginId: string | undefined;
}): string[] {
  return params.manifestPlugins
    .filter((plugin) => {
      if (plugin.channels.some((channelId) => params.configuredChannelIds.has(channelId))) {
        return true;
      }
      if (params.requiredAgentHarnessPluginIds.has(plugin.id)) {
        const activationState = resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: params.pluginsConfig,
          rootConfig: params.rootConfig,
          enabledByDefault: plugin.enabledByDefault,
          activationSource: params.activationSource,
        });
        return activationState.enabled;
      }
      if (
        !shouldConsiderForGatewayStartup({
          plugin,
          startupDreamingPluginIds: params.startupDreamingPluginIds,
          explicitMemorySlotStartupPluginId: params.explicitMemorySlotStartupPluginId,
        })
      ) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.id,
        origin: plugin.origin,
        config: params.pluginsConfig,
        rootConfig: params.rootConfig,
        enabledByDefault: plugin.enabledByDefault,
        activationSource: params.activationSource,
      });
      if (!activationState.enabled) {
        return false;
      }
      if (plugin.origin !== "bundled") {
        return activationState.explicitlyEnabled;
      }
      return activationState.source === "explicit" || activationState.source === "default";
    })
    .map((plugin) => plugin.id);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const requiredAgentHarnessPluginIds = new Set(
    collectConfiguredAgentHarnessRuntimes(
      params.activationSourceConfig ?? params.config,
      params.env,
    ).flatMap((runtime) =>
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: true,
      }),
    ),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const explicitMemorySlotStartupPluginId = resolveExplicitMemorySlotStartupPluginId(
    params.activationSourceConfig ?? params.config,
  );
  const manifestRegistry = loadPluginManifestRegistrySync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return listGatewayStartupPluginIdsFromManifestPlugins({
    rootConfig: params.config,
    manifestPlugins: manifestRegistry.plugins,
    configuredChannelIds,
    pluginsConfig,
    activationSource,
    requiredAgentHarnessPluginIds,
    startupDreamingPluginIds,
    explicitMemorySlotStartupPluginId,
  });
}

export async function resolveGatewayStartupPluginIdsAsync(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  const pluginsConfig = normalizePluginsConfig(params.config.plugins);
  const activationSource = createPluginActivationSource({
    config: params.activationSourceConfig ?? params.config,
  });
  const harnessRuntimes = collectConfiguredAgentHarnessRuntimes(
    params.activationSourceConfig ?? params.config,
    params.env,
  );
  const harnessIdLists = await Promise.all(
    harnessRuntimes.map((runtime) =>
      resolveManifestActivationPluginIdsAsync({
        trigger: {
          kind: "agentHarness",
          runtime,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: true,
      }),
    ),
  );
  const requiredAgentHarnessPluginIds = new Set(harnessIdLists.flat());
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const explicitMemorySlotStartupPluginId = resolveExplicitMemorySlotStartupPluginId(
    params.activationSourceConfig ?? params.config,
  );
  const manifestRegistry = await loadPluginManifestRegistryAsync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return listGatewayStartupPluginIdsFromManifestPlugins({
    rootConfig: params.config,
    manifestPlugins: manifestRegistry.plugins,
    configuredChannelIds,
    pluginsConfig,
    activationSource,
    requiredAgentHarnessPluginIds,
    startupDreamingPluginIds,
    explicitMemorySlotStartupPluginId,
  });
}
