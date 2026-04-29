import {
  resolveBundledPluginCompatibleActivationInputs,
  resolveBundledPluginCompatibleActivationInputsAsync,
  withActivatedPluginIds,
} from "./activation-context.js";
import {
  resolveManifestActivationPluginIds,
  resolveManifestActivationPluginIdsAsync,
} from "./activation-planner.js";
import { loadPluginManifestRegistryAsync } from "./manifest-registry.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  loadOpenClawPluginsAsync,
  resolveRuntimePluginRegistry,
  resolveRuntimePluginRegistryAsync,
  type PluginLoadOptions,
} from "./loader.js";
import { hasExplicitPluginIdScope } from "./plugin-scope.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveActivatableProviderOwnerPluginIdsAsync,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveDiscoverableProviderOwnerPluginIdsAsync,
  resolveDiscoveredProviderPluginIds,
  resolveDiscoveredProviderPluginIdsAsync,
  resolveEnabledProviderPluginIds,
  resolveEnabledProviderPluginIdsAsync,
  resolveBundledProviderCompatPluginIds,
  resolveBundledProviderCompatPluginIdsAsync,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForModelRefs,
  withBundledProviderVitestCompat,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export type ResolveExplicitProviderOwnerPluginIdsParams = {
  providerRefs: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
};

function resolveExplicitProviderOwnerPluginIds(params: ResolveExplicitProviderOwnerPluginIdsParams): string[] {
  return dedupeSortedPluginIds(
    params.providerRefs.flatMap((provider) => {
      const plannedPluginIds = resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
      if (plannedPluginIds.length > 0) {
        return plannedPluginIds;
      }
      // Keep legacy provider/CLI-backend ownership working until every owner is
      // expressible through activation descriptors.
      return (
        resolveOwningPluginIdsForProvider({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
        }) ?? []
      );
    }),
  );
}

export async function resolveExplicitProviderOwnerPluginIdsAsync(
  params: ResolveExplicitProviderOwnerPluginIdsParams,
): Promise<string[]> {
  const nested = await Promise.all(
    params.providerRefs.map(async (provider) => {
      const plannedPluginIds = await resolveManifestActivationPluginIdsAsync({
        trigger: {
          kind: "provider",
          provider,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
      if (plannedPluginIds.length > 0) {
        return plannedPluginIds;
      }
      return (
        resolveOwningPluginIdsForProvider({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
        }) ?? []
      );
    }),
  );
  return dedupeSortedPluginIds(nested.flat());
}

function mergeExplicitOwnerPluginIds(
  providerPluginIds: readonly string[],
  explicitOwnerPluginIds: readonly string[],
): string[] {
  if (explicitOwnerPluginIds.length === 0) {
    return [...providerPluginIds];
  }
  return dedupeSortedPluginIds([...providerPluginIds, ...explicitOwnerPluginIds]);
}

export type PluginProviderLoadBaseParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
};

function resolvePluginProviderLoadBase(params: PluginProviderLoadBaseParams) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const providerOwnedPluginIds = params.providerRefs?.length
    ? resolveExplicitProviderOwnerPluginIds({
        providerRefs: params.providerRefs,
        config: params.config,
        workspaceDir,
        env,
      })
    : [];
  const modelOwnedPluginIds = params.modelRefs?.length
    ? resolveOwningPluginIdsForModelRefs({
        models: params.modelRefs,
        config: params.config,
        workspaceDir,
        env,
      })
    : [];
  const requestedPluginIds =
    hasExplicitPluginIdScope(params.onlyPluginIds) ||
    params.providerRefs?.length ||
    params.modelRefs?.length ||
    providerOwnedPluginIds.length > 0 ||
    modelOwnedPluginIds.length > 0
      ? [
          ...new Set([
            ...(params.onlyPluginIds ?? []),
            ...providerOwnedPluginIds,
            ...modelOwnedPluginIds,
          ]),
        ].toSorted((left, right) => left.localeCompare(right))
      : undefined;
  const explicitOwnerPluginIds = dedupeSortedPluginIds([
    ...providerOwnedPluginIds,
    ...modelOwnedPluginIds,
  ]);
  return {
    env,
    workspaceDir,
    requestedPluginIds,
    explicitOwnerPluginIds,
    rawConfig: params.config,
  };
}

export async function resolvePluginProviderLoadBaseAsync(
  params: PluginProviderLoadBaseParams,
): Promise<ReturnType<typeof resolvePluginProviderLoadBase>> {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const providerOwnedPluginIds = params.providerRefs?.length
    ? await resolveExplicitProviderOwnerPluginIdsAsync({
        providerRefs: params.providerRefs,
        config: params.config,
        workspaceDir,
        env,
      })
    : [];
  let modelOwnedPluginIds: string[] = [];
  if (params.modelRefs?.length) {
    const manifestRegistry = await loadPluginManifestRegistryAsync({
      config: params.config,
      workspaceDir,
      env,
    });
    modelOwnedPluginIds = resolveOwningPluginIdsForModelRefs({
      models: params.modelRefs,
      config: params.config,
      workspaceDir,
      env,
      manifestRegistry,
    });
  }
  const requestedPluginIds =
    hasExplicitPluginIdScope(params.onlyPluginIds) ||
    params.providerRefs?.length ||
    params.modelRefs?.length ||
    providerOwnedPluginIds.length > 0 ||
    modelOwnedPluginIds.length > 0
      ? [
          ...new Set([
            ...(params.onlyPluginIds ?? []),
            ...providerOwnedPluginIds,
            ...modelOwnedPluginIds,
          ]),
        ].toSorted((left, right) => left.localeCompare(right))
      : undefined;
  const explicitOwnerPluginIds = dedupeSortedPluginIds([
    ...providerOwnedPluginIds,
    ...modelOwnedPluginIds,
  ]);
  return {
    env,
    workspaceDir,
    requestedPluginIds,
    explicitOwnerPluginIds,
    rawConfig: params.config,
  };
}

export type ResolvePluginProvidersParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
  mode?: "runtime" | "setup";
  includeUntrustedWorkspacePlugins?: boolean;
};

function resolveSetupProviderPluginLoadState(
  params: ResolvePluginProvidersParams,
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const providerPluginIds = resolveDiscoveredProviderPluginIds({
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const explicitOwnerPluginIds = resolveDiscoverableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  return finalizeSetupProviderPluginLoadState(params, base, {
    providerPluginIds,
    explicitOwnerPluginIds,
  });
}

function finalizeSetupProviderPluginLoadState(
  params: ResolvePluginProvidersParams,
  base: Pick<
    ReturnType<typeof resolvePluginProviderLoadBase>,
    "workspaceDir" | "env" | "rawConfig"
  >,
  ownerIds: { providerPluginIds: string[]; explicitOwnerPluginIds: string[] },
) {
  const { providerPluginIds, explicitOwnerPluginIds } = ownerIds;
  const setupPluginIds = mergeExplicitOwnerPluginIds(providerPluginIds, explicitOwnerPluginIds);
  if (setupPluginIds.length === 0) {
    return undefined;
  }
  const setupConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: setupPluginIds,
  });
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: setupConfig,
      activationSourceConfig: setupConfig,
      autoEnabledReasons: {},
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: setupPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

/**
 * Like {@link resolveSetupProviderPluginLoadState}, but uses async manifest
 * resolution so I/O is awaitable.
 */
export async function resolveSetupProviderPluginLoadStateAsync(
  params: ResolvePluginProvidersParams,
  base: Awaited<ReturnType<typeof resolvePluginProviderLoadBaseAsync>>,
): Promise<ReturnType<typeof resolveSetupProviderPluginLoadState>> {
  const [providerPluginIds, explicitOwnerPluginIds] = await Promise.all([
    resolveDiscoveredProviderPluginIdsAsync({
      config: params.config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      onlyPluginIds: base.requestedPluginIds,
      includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    }),
    resolveDiscoverableProviderOwnerPluginIdsAsync({
      pluginIds: base.explicitOwnerPluginIds,
      config: params.config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    }),
  ]);
  return finalizeSetupProviderPluginLoadState(params, base, {
    providerPluginIds,
    explicitOwnerPluginIds,
  });
}

function resolveRuntimeProviderPluginLoadState(
  params: ResolvePluginProvidersParams,
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const explicitOwnerPluginIds = resolveActivatableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: base.rawConfig,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const runtimeRequestedPluginIds =
    base.requestedPluginIds !== undefined
      ? dedupeSortedPluginIds([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
      : undefined;
  const requestConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: explicitOwnerPluginIds,
  });
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: requestConfig,
    env: base.env,
    workspaceDir: base.workspaceDir,
    onlyPluginIds: runtimeRequestedPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledProviderAllowlistCompat,
      enablement: "allowlist",
      vitest: params.bundledProviderVitestCompat,
    },
    resolveCompatPluginIds: resolveBundledProviderCompatPluginIds,
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        pluginIds: activation.compatPluginIds,
        env: base.env,
      })
    : activation.config;
  const providerPluginIds = mergeExplicitOwnerPluginIds(
    resolveEnabledProviderPluginIds({
      config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      onlyPluginIds: runtimeRequestedPluginIds,
    }),
    explicitOwnerPluginIds,
  );
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config,
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

/**
 * Full async parallel to {@link resolveRuntimeProviderPluginLoadState}: same control flow
 * and outputs, with owner/enabled id resolution on async manifest load paths.
 */
export async function resolveRuntimeProviderPluginLoadStateAsync(
  params: ResolvePluginProvidersParams,
  base: Awaited<ReturnType<typeof resolvePluginProviderLoadBaseAsync>>,
): Promise<ReturnType<typeof resolveRuntimeProviderPluginLoadState>> {
  const explicitOwnerPluginIds = await resolveActivatableProviderOwnerPluginIdsAsync({
    pluginIds: base.explicitOwnerPluginIds,
    config: base.rawConfig,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const runtimeRequestedPluginIds =
    base.requestedPluginIds !== undefined
      ? dedupeSortedPluginIds([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
      : undefined;
  const requestConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: explicitOwnerPluginIds,
  });
  const activation = await resolveBundledPluginCompatibleActivationInputsAsync({
    rawConfig: requestConfig,
    env: base.env,
    workspaceDir: base.workspaceDir,
    onlyPluginIds: runtimeRequestedPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledProviderAllowlistCompat,
      enablement: "allowlist",
      vitest: params.bundledProviderVitestCompat,
    },
    resolveCompatPluginIds: resolveBundledProviderCompatPluginIdsAsync,
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        pluginIds: activation.compatPluginIds,
        env: base.env,
      })
    : activation.config;
  const providerPluginIds = mergeExplicitOwnerPluginIds(
    await resolveEnabledProviderPluginIdsAsync({
      config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      onlyPluginIds: runtimeRequestedPluginIds,
    }),
    explicitOwnerPluginIds,
  );
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config,
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

export function isPluginProvidersLoadInFlight(params: ResolvePluginProvidersParams): boolean {
  const base = resolvePluginProviderLoadBase(params);
  const loadState =
    params.mode === "setup"
      ? resolveSetupProviderPluginLoadState(params, base)
      : resolveRuntimeProviderPluginLoadState(params, base);
  if (!loadState) {
    return false;
  }
  return isPluginRegistryLoadInFlight(loadState.loadOptions);
}

export function resolvePluginProviders(params: ResolvePluginProvidersParams): ProviderPlugin[] {
  const base = resolvePluginProviderLoadBase(params);
  if (params.mode === "setup") {
    const loadState = resolveSetupProviderPluginLoadState(params, base);
    if (!loadState) {
      return [];
    }
    const registry = loadOpenClawPlugins(loadState.loadOptions);
    return registry.providers.map((entry) =>
      Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
    );
  }
  const loadState = resolveRuntimeProviderPluginLoadState(params, base);
  const registry = resolveRuntimePluginRegistry(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) =>
    Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
  );
}

export async function resolvePluginProvidersAsync(
  params: ResolvePluginProvidersParams,
): Promise<ProviderPlugin[]> {
  const base = await resolvePluginProviderLoadBaseAsync(params);
  if (params.mode === "setup") {
    const loadState = await resolveSetupProviderPluginLoadStateAsync(params, base);
    if (!loadState) {
      return [];
    }
    const registry = await loadOpenClawPluginsAsync(loadState.loadOptions);
    return registry.providers.map((entry) =>
      Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
    );
  }
  const loadState = await resolveRuntimeProviderPluginLoadStateAsync(params, base);
  const registry = await resolveRuntimePluginRegistryAsync(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) =>
    Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
  );
}

export async function isPluginProvidersLoadInFlightAsync(
  params: ResolvePluginProvidersParams,
): Promise<boolean> {
  const base = await resolvePluginProviderLoadBaseAsync(params);
  const loadState =
    params.mode === "setup"
      ? await resolveSetupProviderPluginLoadStateAsync(params, base)
      : await resolveRuntimeProviderPluginLoadStateAsync(params, base);
  if (!loadState) {
    return false;
  }
  return isPluginRegistryLoadInFlight(loadState.loadOptions);
}
