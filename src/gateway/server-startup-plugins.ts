import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadPluginLookUpTable,
  type PluginLookUpTable,
} from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  resolveConfiguredDeferredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "../plugins/channel-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listCoreGatewayMethodNames } from "./methods/core-descriptors.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { loadGatewayStartupPluginsAsync } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  const startupMaintenanceConfig =
    params.cfgAtStart.channels === undefined && params.startupRuntimeConfig.channels !== undefined
      ? {
          ...params.cfgAtStart,
          channels: params.startupRuntimeConfig.channels,
        }
      : params.cfgAtStart;

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const startupTasks = [
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    ];
    if (!params.minimalTestGateway) {
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
    }
    await Promise.all(startupTasks);
  }

  initSubagentRegistry();

  const autoEnabled = params.minimalTestGateway
    ? undefined
    : applyPluginAutoEnable({
        config: activationSourceConfig,
        env: process.env,
        ...(params.pluginMetadataSnapshot?.manifestRegistry
          ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
          : {}),
      });
  const gatewayPluginConfigAtStart =
    params.minimalTestGateway || !autoEnabled
      ? params.cfgAtStart
      : activationSourceConfig === params.startupRuntimeConfig
        ? autoEnabled.config
        : mergeActivationSectionsIntoRuntimeConfig({
            runtimeConfig: params.startupRuntimeConfig,
            activationConfig: autoEnabled.config,
          });
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfigAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfigAtStart, defaultAgentId);
  const pluginsGloballyDisabled = gatewayPluginConfigAtStart.plugins?.enabled === false;
  const pluginLookUpTable: PluginLookUpTable | undefined =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfigAtStart,
          activationSourceConfig,
          workspaceDir: defaultWorkspaceDir,
          env: process.env,
          ...(params.pluginMetadataSnapshot
            ? { metadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
        });
  const deferredConfiguredChannelPluginIds = params.minimalTestGateway
    ? []
    : pluginLookUpTable
      ? [...pluginLookUpTable.startup.configuredDeferredChannelPluginIds]
      : pluginsGloballyDisabled
        ? []
        : resolveConfiguredDeferredChannelPluginIds({
            config: gatewayPluginConfigAtStart,
            workspaceDir: defaultWorkspaceDir,
            env: process.env,
          });
  const startupPluginIds = params.minimalTestGateway
    ? []
    : pluginLookUpTable
      ? [...pluginLookUpTable.startup.pluginIds]
      : pluginsGloballyDisabled
        ? []
        : resolveGatewayStartupPluginIds({
            config: gatewayPluginConfigAtStart,
            activationSourceConfig,
            workspaceDir: defaultWorkspaceDir,
            env: process.env,
          });

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;

  if (!params.minimalTestGateway) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginsAsync({
      cfg: gatewayPluginConfigAtStart,
      activationSourceConfig: params.cfgAtStart,
      workspaceDir: defaultWorkspaceDir,
      log: params.log,
      coreGatewayHandlers,
      coreGatewayMethodNames: listCoreGatewayMethodNames(),
      baseMethods,
      pluginIds: startupPluginIds,
      pluginLookUpTable,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
      suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0,
    }));
  } else {
    pluginRegistry = getActivePluginRegistry() ?? emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    baseMethods,
    pluginLookUpTable,
    pluginRegistry,
    baseGatewayMethods,
  };
}
