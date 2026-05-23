import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  configMayNeedPluginAutoEnable,
  resolveConfiguredPluginAutoEnableCandidates,
  resolveConfiguredPluginAutoEnableCandidatesAsync,
  resolvePluginAutoEnableManifestRegistry,
  resolvePluginAutoEnableManifestRegistryAsync,
} from "./plugin-auto-enable.shared.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function detectPluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableCandidate[] {
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  if (!configMayNeedPluginAutoEnable(config, env)) {
    return [];
  }
  const registry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return resolveConfiguredPluginAutoEnableCandidates({
    config,
    env,
    registry,
  });
}

/**
 * Async counterpart to {@link detectPluginAutoEnableCandidates} for async config
 * or manifest boundaries. Uses {@link resolveConfiguredPluginAutoEnableCandidatesAsync}
 * after manifest resolution.
 */
export async function detectPluginAutoEnableCandidatesAsync(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): Promise<PluginAutoEnableCandidate[]> {
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  if (!configMayNeedPluginAutoEnable(config, env)) {
    return [];
  }
  const registry = await resolvePluginAutoEnableManifestRegistryAsync({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return await resolveConfiguredPluginAutoEnableCandidatesAsync({
    config,
    env,
    registry,
  });
}
