import { beforeEach, describe, expect, it, vi } from "vitest";

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistrySync = vi.hoisted(() => vi.fn());

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistrySync,
}));

import { resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    loadPluginManifestRegistrySync.mockReset().mockReturnValue({ plugins: [] });
  });

  it("uses manifest-owned synthetic auth refs before the runtime registry exists", () => {
    loadPluginManifestRegistrySync.mockReturnValue({
      plugins: [
        { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
        { syntheticAuthRefs: ["remote-provider"] },
        { syntheticAuthRefs: [] },
      ],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "local-provider",
      "local-cli",
      "remote-provider",
    ]);
    expect(loadPluginManifestRegistrySync).toHaveBeenCalledWith({ cache: true });
  });

  it("prefers the active runtime registry when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveSyntheticAuth: () => undefined,
            },
          },
          {
            provider: {
              id: "plain-provider",
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveSyntheticAuth: () => undefined,
            },
          },
        ],
      },
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual(["runtime-provider", "runtime-cli"]);
    expect(loadPluginManifestRegistrySync).not.toHaveBeenCalled();
  });
});
