import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  detectPluginAutoEnableCandidates,
  detectPluginAutoEnableCandidatesAsync,
} from "./plugin-auto-enable.detect.js";
import {
  materializePluginAutoEnableCandidatesInternal,
  resolvePluginAutoEnableManifestRegistry,
  resolvePluginAutoEnableManifestRegistryAsync,
} from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function materializePluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return materializePluginAutoEnableCandidatesInternal({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
}

/**
 * Like {@link materializePluginAutoEnableCandidates}, but resolves the manifest
 * registry via {@link resolvePluginAutoEnableManifestRegistryAsync}.
 */
export async function materializePluginAutoEnableCandidatesAsync(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): Promise<PluginAutoEnableResult> {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const manifestRegistry = await resolvePluginAutoEnableManifestRegistryAsync({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return materializePluginAutoEnableCandidatesInternal({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
}

export function applyPluginAutoEnable(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const candidates = detectPluginAutoEnableCandidates(params);
  return materializePluginAutoEnableCandidates({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
}

/**
 * Async counterpart to {@link applyPluginAutoEnable} for config/plugin async
 * boundaries. Uses {@link detectPluginAutoEnableCandidatesAsync} then the same
 * materialization path as the sync function.
 */
export async function applyPluginAutoEnableAsync(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): Promise<PluginAutoEnableResult> {
  const candidates = await detectPluginAutoEnableCandidatesAsync(params);
  return materializePluginAutoEnableCandidatesAsync({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
}
