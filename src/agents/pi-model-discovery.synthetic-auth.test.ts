// @ts-nocheck
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveRuntimeSyntheticAuthProviderRefs = vi.hoisted(() => vi.fn(() => ["claude-cli"]));

const resolveProviderSyntheticAuthWithPlugin = vi.hoisted(() =>
  vi.fn((params: { provider: string }) =>
    params.provider === "claude-cli"
      ? {
          apiKey: "claude-cli-access-token",
          source: "Claude CLI native auth",
          mode: "oauth" as const,
        }
      : undefined,
  ),
);

const resolveProviderSyntheticAuthWithPluginAsync = vi.hoisted(() =>
  vi.fn(async (params: { provider: string }) => resolveProviderSyntheticAuthWithPlugin(params)),
);

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefsAsync: async () => resolveRuntimeSyntheticAuthProviderRefs(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin,
  resolveProviderSyntheticAuthWithPluginAsync,
  resolveExternalAuthProfilesWithPlugins: () => [],
  resolveExternalAuthProfilesWithPluginsAsync: async () => [],
}));

let discoverAuthStorage: typeof import("./pi-model-discovery.js").discoverAuthStorage;
let discoverAuthStorageAsync: typeof import("./pi-model-discovery.js").discoverAuthStorageAsync;
let resolvePiCredentialsForDiscovery: typeof import("./pi-auth-discovery.js").resolvePiCredentialsForDiscovery;

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-synthetic-auth-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("pi model discovery synthetic auth", () => {
  beforeAll(async () => {
    ({ discoverAuthStorage, discoverAuthStorageAsync } = await import("./pi-model-discovery.js"));
    ({ resolvePiCredentialsForDiscovery } = await import("./pi-auth-discovery.js"));
  });

  beforeEach(() => {
    resolveRuntimeSyntheticAuthProviderRefs.mockClear();
    resolveProviderSyntheticAuthWithPlugin.mockClear();
    resolveProviderSyntheticAuthWithPluginAsync.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mirrors plugin-owned synthetic cli auth into pi credential discovery", async () => {
    await withAgentDir(async (agentDir) => {
      const credentials = resolvePiCredentialsForDiscovery(agentDir, { readOnly: true });

      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledTimes(1);
      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledWith();
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledTimes(1);
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
        provider: "claude-cli",
        context: {
          config: undefined,
          provider: "claude-cli",
          providerConfig: undefined,
        },
      });
      expect(credentials["claude-cli"]).toEqual({
        type: "api_key",
        key: "claude-cli-access-token",
      });
    });
  });

  it("mirrors plugin-owned synthetic cli auth into pi auth storage (async discover path)", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {},
        },
        agentDir,
      );

      const authStorage = await discoverAuthStorageAsync(agentDir);

      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalled();
      expect(resolveProviderSyntheticAuthWithPluginAsync).toHaveBeenCalledWith({
        provider: "claude-cli",
        context: {
          config: undefined,
          provider: "claude-cli",
          providerConfig: undefined,
        },
      });
      expect(authStorage.hasAuth("claude-cli")).toBe(true);
      await expect(authStorage.getApiKey("claude-cli")).resolves.toBe("claude-cli-access-token");
    });
  });
});
