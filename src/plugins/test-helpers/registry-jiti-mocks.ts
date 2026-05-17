import { vi } from "vitest";

const registryJitiMocks = vi.hoisted(() => ({
  createJiti: vi.fn(),
  discoverOpenClawPlugins: vi.fn(),
  loadPluginManifestRegistrySync: vi.fn(),
}));

vi.mock("../discovery.js", () => ({
  discoverOpenClawPlugins: (
    ...args: Parameters<typeof registryJitiMocks.discoverOpenClawPlugins>
  ) => registryJitiMocks.discoverOpenClawPlugins(...args),
  discoverOpenClawPluginsAsync: (
    ...args: Parameters<typeof registryJitiMocks.discoverOpenClawPlugins>
  ) => Promise.resolve(registryJitiMocks.discoverOpenClawPlugins(...args)),
}));

vi.mock("../manifest-registry.js", () => ({
  loadPluginManifestRegistrySync: (
    ...args: Parameters<typeof registryJitiMocks.loadPluginManifestRegistrySync>
  ) => registryJitiMocks.loadPluginManifestRegistrySync(...args),
  loadPluginManifestRegistryAsync: (
    ...args: Parameters<typeof registryJitiMocks.loadPluginManifestRegistrySync>
  ) => Promise.resolve(registryJitiMocks.loadPluginManifestRegistrySync(...args)),
}));

export function resetRegistryJitiMocks(): void {
  registryJitiMocks.createJiti.mockReset();
  registryJitiMocks.discoverOpenClawPlugins.mockReset();
  registryJitiMocks.loadPluginManifestRegistrySync.mockReset();
  registryJitiMocks.discoverOpenClawPlugins.mockReturnValue({
    candidates: [],
    diagnostics: [],
  });
  registryJitiMocks.createJiti.mockImplementation(
    (_modulePath: string, _options?: Record<string, unknown>) => () => ({ default: {} }),
  );
}

export function getRegistryJitiMocks() {
  return registryJitiMocks;
}
