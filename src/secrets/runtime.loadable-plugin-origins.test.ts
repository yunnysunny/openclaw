import { afterEach, describe, expect, it, vi } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const loadPluginManifestRegistrySync = vi.hoisted(() => vi.fn());

vi.mock("./runtime-manifest.runtime.js", () => ({
  loadPluginManifestRegistrySync,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    loadPluginManifestRegistrySync.mockReset();
  });

  it("skips manifest registry loading when plugin entries are absent", async () => {
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
            },
          },
        },
      }),
      env: { OPENAI_API_KEY: "sk-test" },
      includeAuthStoreRefs: false,
    });

    expect(loadPluginManifestRegistrySync).not.toHaveBeenCalled();
  });
});
