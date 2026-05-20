// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

const { loadPluginManifestRegistrySyncMock } = vi.hoisted(() => ({
  loadPluginManifestRegistrySyncMock: vi.fn(),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistrySync: loadPluginManifestRegistrySyncMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
  beforeEach(() => {
    loadPluginManifestRegistrySyncMock.mockReset();
  });

  it("collects manifest-declared dangerous plugin config values", () => {
    loadPluginManifestRegistrySyncMock.mockReturnValue({
      plugins: [
        {
          id: "acpx",
          configContracts: {
            dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      collectEnabledInsecureOrDangerousFlags(
        asConfig({
          plugins: {
            entries: {
              acpx: {
                config: {
                  permissionMode: "approve-all",
                },
              },
            },
          },
        }),
      ),
    ).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
  });

  it("ignores plugin config values that are not declared as dangerous", () => {
    loadPluginManifestRegistrySyncMock.mockReturnValue({
      plugins: [
        {
          id: "other",
          configContracts: {
            dangerousFlags: [{ path: "mode", equals: "danger" }],
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      collectEnabledInsecureOrDangerousFlags(
        asConfig({
          plugins: {
            entries: {
              other: {
                config: {
                  mode: "safe",
                },
              },
            },
          },
        }),
      ),
    ).toStrictEqual([]);
  });

  it("collects dangerous sandbox, hook, browser, and fs flags", () => {
    const flags = collectEnabledInsecureOrDangerousFlagsFromContracts(
      asConfig({
        agents: {
          defaults: {
            sandbox: {
              docker: {
                dangerouslyAllowReservedContainerTargets: true,
                dangerouslyAllowContainerNamespaceJoin: true,
              },
            },
          },
          list: [
            {
              id: "worker",
              sandbox: {
                docker: {
                  dangerouslyAllowExternalBindSources: true,
                },
              },
            },
          ],
        },
        hooks: {
          allowRequestSessionKey: true,
        },
        browser: {
          ssrfPolicy: {
            dangerouslyAllowPrivateNetwork: true,
          },
        },
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      }),
    );

    expect(flags).toStrictEqual([
      "hooks.allowRequestSessionKey=true",
      "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true",
      "tools.fs.workspaceOnly=false",
      "agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets=true",
      "agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true",
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowExternalBindSources=true',
    ]);
  });

  it("collects configured security audit suppressions as a dangerous flag", () => {
    expect(
      collectEnabledInsecureOrDangerousFlags(
        asConfig({
          security: {
            audit: {
              suppressions: [{ checkId: "plugins.code_safety" }],
            },
          },
        }),
      ),
    ).toContain("security.audit.suppressions configured (1)");
  });

  it("uses stable agent ids for per-agent dangerous sandbox flags", () => {
    expect(
      collectEnabledInsecureOrDangerousFlags(
        asConfig({
          agents: {
            list: [
              {
                id: "worker",
                sandbox: {
                  docker: {
                    dangerouslyAllowContainerNamespaceJoin: true,
                  },
                },
              },
              {
                id: "helper",
              },
            ],
          },
        }),
      ),
    ).toContain(
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true',
    );

    expect(
      collectEnabledInsecureOrDangerousFlags(
        asConfig({
          agents: {
            list: [
              {
                id: "helper",
              },
              {
                id: "worker",
                sandbox: {
                  docker: {
                    dangerouslyAllowContainerNamespaceJoin: true,
                  },
                },
              },
            ],
          },
        }),
      ),
    ).toContain(
      'agents.list[id="worker"].sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true',
    );
  });
});
