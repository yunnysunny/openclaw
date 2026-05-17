import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUserPath } from "../utils.js";

const hoisted = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  resolveRuntimePluginRegistryAsync: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(
    () => "default",
  ),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: hoisted.resolveRuntimePluginRegistry,
  resolveRuntimePluginRegistryAsync: hoisted.resolveRuntimePluginRegistryAsync,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

describe("ensureRuntimePluginsLoaded", () => {
  const workspaceDir = resolveUserPath("/tmp/workspace");
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;
  let ensureRuntimePluginsLoadedAsync: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoadedAsync;

  beforeEach(async () => {
    hoisted.resolveRuntimePluginRegistry.mockReset();
    hoisted.resolveRuntimePluginRegistryAsync.mockReset();
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.resolveRuntimePluginRegistryAsync.mockResolvedValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded, ensureRuntimePluginsLoadedAsync } =
      await import("./runtime-plugins.js"));
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    hoisted.resolveRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir,
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir,
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("resolves runtime plugins through the shared async runtime helper", async () => {
    await ensureRuntimePluginsLoadedAsync({
      config: {} as never,
      workspaceDir,
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistryAsync).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("does not enable gateway subagent binding for normal runtime loads", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: undefined,
    });
  });

  it("inherits gateway-bindable mode from an active gateway registry", async () => {
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });
});
