import { beforeEach, describe, expect, it, vi } from "vitest";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    channelEnvVars?: Record<string, string[]>;
  }>;
  diagnostics: unknown[];
};

const loadPluginManifestRegistrySync = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({ plugins: [], diagnostics: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistrySync,
}));

describe("channel env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistrySync.mockReset();
    loadPluginManifestRegistrySync.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    loadPluginManifestRegistrySync.mockReturnValue({
      plugins: [
        {
          id: "external-mattermost",
          origin: "global",
          channelEnvVars: {
            mattermost: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
    const knownNames = mod.listKnownChannelEnvVarNames();
    expect(knownNames).toContain("MATTERMOST_BOT_TOKEN");
    expect(knownNames).toContain("MATTERMOST_URL");
  });
});
