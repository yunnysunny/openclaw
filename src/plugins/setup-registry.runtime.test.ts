import { afterEach, describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistrySyncMock = vi.hoisted(() => vi.fn());

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistrySync: loadPluginManifestRegistrySyncMock,
}));

afterEach(() => {
  loadPluginManifestRegistrySyncMock.mockReset();
});

describe("setup-registry runtime fallback", () => {
  it("uses bundled manifest cliBackends when the setup-registry runtime is unavailable", async () => {
    loadPluginManifestRegistrySyncMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          cliBackends: ["legacy-openai-cli"],
          setup: {
            cliBackends: ["Codex-CLI"],
            requiresRuntime: true,
          },
        },
        {
          id: "local",
          origin: "workspace",
          cliBackends: ["local-cli"],
        },
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendRuntime({ backend: "local-cli" })).toBeUndefined();
    expect(loadPluginManifestRegistrySyncMock).toHaveBeenCalledTimes(1);
    expect(loadPluginManifestRegistrySyncMock).toHaveBeenCalledWith({ cache: true });
  });

  it("does not reuse workspace-scoped current metadata without a workspace context", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [],
      },
      plugins: [],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        cliBackends: ["Codex-CLI"],
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(
      resolvePluginSetupCliBackendRuntime({ backend: "codex-cli", config: {} }),
    ).toBeUndefined();
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
  });

  it("preserves fail-closed setup lookup when the runtime module explicitly declines to resolve", async () => {
    loadPluginManifestRegistrySyncMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          cliBackends: ["legacy-openai-cli"],
          setup: {
            cliBackends: ["Codex-CLI"],
            requiresRuntime: true,
          },
        },
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(loadPluginManifestRegistrySyncMock).not.toHaveBeenCalled();
  });
});
