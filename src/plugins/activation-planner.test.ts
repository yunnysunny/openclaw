import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistrySync: vi.fn(),
  loadPluginManifestRegistryAsync: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistrySync: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistrySync(...args),
  loadPluginManifestRegistryAsync: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryAsync(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;
let resolveManifestActivationPluginIdsAsync: typeof import("./activation-planner.js").resolveManifestActivationPluginIdsAsync;

describe("resolveManifestActivationPluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPluginIds, resolveManifestActivationPluginIdsAsync } =
      await import("./activation-planner.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistrySync.mockReset();
    mocks.loadPluginManifestRegistryAsync.mockReset();
    const registry = {
      plugins: [
        {
          id: "memory-core",
          commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "device-pair",
          commandAliases: [{ name: "pair", kind: "runtime-slash" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "openai",
          providers: ["openai"],
          activation: {
            onAgentHarnesses: ["codex"],
          },
          setup: {
            providers: [{ id: "openai-codex" }],
          },
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "demo-channel",
          channels: ["telegram"],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: ["before-agent-start"],
          contracts: {
            tools: ["web-search"],
          },
          activation: {
            onRoutes: ["webhook"],
            onCommands: ["demo-tools"],
          },
          origin: "workspace",
        },
      ],
      diagnostics: [],
    };
    mocks.loadPluginManifestRegistrySync.mockReturnValue(registry);
    mocks.loadPluginManifestRegistryAsync.mockResolvedValue(registry);
  });

  it("matches command triggers from activation metadata and legacy command aliases", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "memory",
        },
      }),
    ).toEqual(["memory-core"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "pair",
        },
      }),
    ).toEqual(["device-pair"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "demo-tools",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("matches provider, agent harness, channel, and route triggers from manifest-owned metadata", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai-codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime: "codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: "telegram",
        },
      }),
    ).toEqual(["demo-channel"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "route",
          route: "webhook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("matches capability triggers from explicit hints or existing manifest ownership", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "provider",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "tool",
        },
      }),
    ).toEqual(["demo-channel"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "hook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
        onlyPluginIds: [],
      }),
    ).toEqual([]);
  });

  it("loads the manifest registry asynchronously and matches the sync planner results", async () => {
    mocks.loadPluginManifestRegistrySync.mockClear();
    mocks.loadPluginManifestRegistryAsync.mockClear();

    await expect(
      resolveManifestActivationPluginIdsAsync({
        trigger: { kind: "command", command: "memory" },
      }),
    ).resolves.toEqual(["memory-core"]);

    await expect(
      resolveManifestActivationPluginIdsAsync({
        trigger: { kind: "provider", provider: "openai" },
      }),
    ).resolves.toEqual(["openai"]);

    await expect(
      resolveManifestActivationPluginIdsAsync({
        trigger: { kind: "provider", provider: "openai" },
        onlyPluginIds: [],
      }),
    ).resolves.toEqual([]);

    expect(mocks.loadPluginManifestRegistryAsync).toHaveBeenCalled();
    expect(mocks.loadPluginManifestRegistrySync).not.toHaveBeenCalled();
  });
});
