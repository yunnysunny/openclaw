import { beforeEach, describe, expect, it, vi } from "vitest";
import * as configPresence from "../../../channels/config-presence.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { scanConfiguredChannelPluginBlockers } from "./channel-plugin-blockers.js";

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips plugin registry work when config has no plugin blocker surfaces", () => {
    const presenceSpy = vi.spyOn(configPresence, "listPotentialConfiguredChannelIds");
    const registrySpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistrySync");

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([]);
    expect(presenceSpy).not.toHaveBeenCalled();
    expect(registrySpy).not.toHaveBeenCalled();
  });

  it("still evaluates configured channels when plugins are disabled globally", () => {
    vi.spyOn(configPresence, "listPotentialConfiguredChannelIds").mockReturnValue(["slack"]);
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistrySync").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistrySync>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        enabled: false,
      },
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "slack",
        pluginId: "slack",
        reason: "plugins disabled",
      },
    ]);
  });
});
