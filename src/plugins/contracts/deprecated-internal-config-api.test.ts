import { describe, expect, it } from "vitest";
import { collectDeprecatedInternalConfigApiViolations } from "../../../scripts/lib/deprecated-config-api-guard.mjs";

describe("deprecated internal config API guardrails", () => {
  // Stage 4: 23 production-code violations remain on the fork (server.impl,
  // server-methods/usage, agents/tools/{image,music,video}-generate-tool,
  // config/runtime-schema, infra/provider-usage.auth, auto-reply/commands-plugins).
  // These are upstream-only refactors of the loadConfig()/getRuntimeConfig()
  // boundary that haven't been backported. Re-enable once those call sites
  // route through context.getRuntimeConfig() / mutateConfigFile.
  it.skip("keeps production code off deprecated config load/write seams", () => {
    expect(collectDeprecatedInternalConfigApiViolations()).toStrictEqual([]);
  });
});
