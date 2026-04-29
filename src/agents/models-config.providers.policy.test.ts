import { beforeEach, describe, expect, it, vi } from "vitest";

type NormalizeProviderSpecificConfig =
  typeof import("./models-config.providers.policy.js").normalizeProviderSpecificConfig;
type ResolveProviderConfigApiKeyResolver =
  typeof import("./models-config.providers.policy.js").resolveProviderConfigApiKeyResolver;
type ResolveProviderConfigApiKeyResolverAsync =
  typeof import("./models-config.providers.policy.js").resolveProviderConfigApiKeyResolverAsync;
type NormalizeProviderSpecificConfigAsync =
  typeof import("./models-config.providers.policy.js").normalizeProviderSpecificConfigAsync;

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
let normalizeProviderSpecificConfig: NormalizeProviderSpecificConfig;
let normalizeProviderSpecificConfigAsync: NormalizeProviderSpecificConfigAsync;
let resolveProviderConfigApiKeyResolver: ResolveProviderConfigApiKeyResolver;
let resolveProviderConfigApiKeyResolverAsync: ResolveProviderConfigApiKeyResolverAsync;

const mockNormalizeProviderConfigWithPlugin = vi.hoisted(() => {
  return (params: {
    provider: string;
    context: { providerConfig?: { baseUrl?: string } };
  }) => {
    if (params.provider !== "google") {
      return undefined;
    }
    const baseUrl = params.context.providerConfig?.baseUrl?.trim();
    if (!baseUrl || baseUrl.endsWith("/v1beta")) {
      return undefined;
    }
    return {
      ...params.context.providerConfig,
      baseUrl:
        baseUrl === GOOGLE_BASE_URL
          ? `${GOOGLE_BASE_URL}/v1beta`
          : params.context.providerConfig?.baseUrl,
    };
  };
});

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: mockNormalizeProviderConfigWithPlugin,
  normalizeProviderConfigWithPluginAsync: async (
    params: Parameters<typeof mockNormalizeProviderConfigWithPlugin>[0],
  ) => mockNormalizeProviderConfigWithPlugin(params),
  resolveProviderConfigApiKeyWithPlugin: (params: {
    provider: string;
    context: { env: NodeJS.ProcessEnv };
  }) => {
    if (params.provider === "amazon-bedrock") {
      return params.context.env.AWS_PROFILE?.trim() ? "AWS_PROFILE" : undefined;
    }
    if (params.provider === "anthropic-vertex") {
      return params.context.env.ANTHROPIC_VERTEX_USE_GCP_METADATA === "true"
        ? "gcp-vertex-credentials"
        : undefined;
    }
    return undefined;
  },
  resolveProviderConfigApiKeyWithPluginAsync: async (params: {
    provider: string;
    context: { env: NodeJS.ProcessEnv };
  }) => {
    if (params.provider === "amazon-bedrock") {
      return params.context.env.AWS_PROFILE?.trim() ? "AWS_PROFILE" : undefined;
    }
    if (params.provider === "anthropic-vertex") {
      return params.context.env.ANTHROPIC_VERTEX_USE_GCP_METADATA === "true"
        ? "gcp-vertex-credentials"
        : undefined;
    }
    return undefined;
  },
}));

beforeEach(async () => {
  vi.resetModules();
  ({
    normalizeProviderSpecificConfig,
    normalizeProviderSpecificConfigAsync,
    resolveProviderConfigApiKeyResolver,
    resolveProviderConfigApiKeyResolverAsync,
  } = await import("./models-config.providers.policy.js"));
});

describe("models-config.providers.policy", () => {
  it("resolves config apiKey markers through provider plugin hooks", async () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.(env)).toBe("AWS_PROFILE");
  });

  it("resolveProviderConfigApiKeyResolverAsync matches sync resolver", async () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const asyncResolver = await resolveProviderConfigApiKeyResolverAsync("amazon-bedrock");
    const syncResolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");
    expect(asyncResolver).toBeTypeOf("function");
    expect(await asyncResolver?.(env)).toBe(syncResolver?.(env));
  });

  it("resolves anthropic-vertex ADC markers through provider plugin hooks", async () => {
    const resolver = resolveProviderConfigApiKeyResolver("anthropic-vertex");

    expect(resolver).toBeTypeOf("function");
    expect(
      resolver?.({
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("gcp-vertex-credentials");
  });

  it("normalizes Google provider config through provider plugin hooks", async () => {
    expect(
      normalizeProviderSpecificConfig("google", {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
      }),
    ).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("normalizeProviderSpecificConfigAsync matches sync Google normalization", async () => {
    const provider = {
      api: "google-generative-ai" as const,
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [],
    };
    expect(await normalizeProviderSpecificConfigAsync("google", provider)).toEqual(
      normalizeProviderSpecificConfig("google", provider),
    );
  });

  it("does not treat generic transport APIs as provider plugin ids", () => {
    const provider = {
      api: "openai-completions" as const,
      baseUrl: "https://example.invalid/v1",
      apiKey: "EXAMPLE_KEY",
      models: [],
    };

    const resolver = resolveProviderConfigApiKeyResolver("dashscope-vision", provider);
    expect(resolver).toBeTypeOf("function");
    expect(resolver?.({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(normalizeProviderSpecificConfig("dashscope-vision", provider)).toBe(provider);
  });
});
