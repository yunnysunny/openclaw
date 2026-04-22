import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestCommandAliasRecord,
} from "./manifest-command-aliases.js";
import { loadPluginManifestRegistrySync } from "./manifest-registry.js";

export function resolveManifestCommandAliasOwner(params: {
  command: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const registry =
    params.registry ??
    loadPluginManifestRegistrySync({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  return resolveManifestCommandAliasOwnerInRegistry({
    command: params.command,
    registry,
  });
}
