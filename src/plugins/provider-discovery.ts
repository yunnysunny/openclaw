import { normalizeProviderId } from "../agents/model-selection.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderDiscoveryOrder[] = ["simple", "profile", "paired", "late"];
let providerRuntimePromise: Promise<typeof import("./provider-discovery.runtime.js")> | undefined;

function loadProviderRuntime() {
  providerRuntimePromise ??= import("./provider-discovery.runtime.js");
  return providerRuntimePromise;
}

function resolveProviderCatalogHook(provider: ProviderPlugin) {
  return provider.catalog ?? provider.discovery;
}

export async function resolvePluginDiscoveryProviders(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): Promise<ProviderPlugin[]> {
  const mod = await loadProviderRuntime();
  const providers = await mod.resolvePluginDiscoveryProvidersRuntimeAsync({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
  });
  return providers.filter((provider) => resolveProviderCatalogHook(provider));
}

export async function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Promise<Record<ProviderDiscoveryOrder, ProviderPlugin[]>> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderDiscoveryOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = resolveProviderCatalogHook(provider)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

export async function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result:
    | { provider: ModelProviderConfig }
    | { providers: Record<string, ModelProviderConfig> }
    | null
    | undefined;
}): Promise<Record<string, ModelProviderConfig>> {
  const result = params.result;
  if (!result) {
    return {};
  }

  if ("provider" in result) {
    const normalized: Record<string, ModelProviderConfig> = {};
    for (const providerId of [
      params.provider.id,
      ...(params.provider.aliases ?? []),
      ...(params.provider.hookAliases ?? []),
    ]) {
      const normalizedKey = normalizeProviderId(providerId);
      if (!normalizedKey) {
        continue;
      }
      normalized[normalizedKey] = result.provider;
    }
    return normalized;
  }

  const normalized: Record<string, ModelProviderConfig> = {};
  for (const [key, value] of Object.entries(result.providers)) {
    const normalizedKey = normalizeProviderId(key);
    if (!normalizedKey || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export async function runProviderCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => Promise<{
    apiKey: string | undefined;
    discoveryApiKey?: string;
  }>;
  resolveProviderAuth: (
    providerId?: string,
    options?: { oauthMarker?: string },
  ) => Promise<{
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  }>;
}) {
  const hook = resolveProviderCatalogHook(params.provider)?.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
  return hook === undefined ? undefined : await hook;
}
