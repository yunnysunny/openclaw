import { describe, expect, it } from "vitest";
import {
  resolveMissingProviderApiKey,
  resolveMissingProviderApiKeyAsync,
} from "./models-config.providers.secret-helpers.js";

const minimaxModelList = {
  baseUrl: "https://api.minimax.io/anthropic",
  api: "anthropic-messages" as const,
  models: [
    {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
  ],
};

describe("models-config", () => {
  it("fills missing provider.apiKey from env var name when models exist", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "minimax",
      provider: minimaxModelList,
      env: { MINIMAX_API_KEY: "sk-minimax-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
  });

  it("resolveMissingProviderApiKeyAsync matches sync for env-based resolution", async () => {
    const params = {
      providerKey: "minimax",
      provider: minimaxModelList,
      env: { MINIMAX_API_KEY: "sk-minimax-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    } as const;
    const asyncProvider = await resolveMissingProviderApiKeyAsync(params);
    const syncProvider = resolveMissingProviderApiKey(params);
    expect(asyncProvider).toEqual(syncProvider);
  });

  it("resolveMissingProviderApiKeyAsync awaits async providerApiKeyResolver", async () => {
    const provider = await resolveMissingProviderApiKeyAsync({
      providerKey: "custom",
      provider: {
        ...minimaxModelList,
        auth: "aws-sdk" as const,
      },
      env: {},
      profileApiKey: undefined,
      providerApiKeyResolver: async () => "AWS_VAULT_KEY",
    });
    expect(provider.apiKey).toBe("AWS_VAULT_KEY");
  });
});
