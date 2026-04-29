import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistrySync: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistrySync: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistrySync(...args),
  resolveManifestContractPluginIds: vi.fn(),
}));

let resolveManifestDeclaredWebProviderCandidatePluginIds: typeof import("./web-provider-resolution-shared.js").resolveManifestDeclaredWebProviderCandidatePluginIds;

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestDeclaredWebProviderCandidatePluginIds } =
      await import("./web-provider-resolution-shared.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistrySync.mockReset();
    mocks.loadPluginManifestRegistrySync.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          configSchema: {
            properties: {
              webSearch: {},
            },
          },
        },
        {
          id: "beta",
          origin: "bundled",
          contracts: {
            webSearchProviders: ["beta-search"],
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: [],
      }),
    ).toEqual([]);
  });

  it("keeps runtime fallback for scoped plugins with no declared web candidates", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: ["missing-plugin"],
      }),
    ).toBeUndefined();
  });

  it("derives provider candidates from a single manifest-registry read", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
      }),
    ).toEqual(["alpha", "beta"]);
    expect(mocks.loadPluginManifestRegistrySync).toHaveBeenCalledTimes(1);
  });
});
