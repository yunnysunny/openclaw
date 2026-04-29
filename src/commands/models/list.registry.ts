import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { shouldSuppressBuiltInModelAsync } from "../../agents/model-suppression.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import { toModelRow as toModelRowBase } from "./list.model-row.js";
import {
  discoverAuthStorageAsync,
  discoverModels,
  hasUsableCustomProviderApiKey,
  listProfilesForProvider,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
  resolveOpenClawAgentDir,
} from "./list.runtime.js";
import type { ModelRow } from "./list.types.js";
import { modelKey } from "./shared.js";

const hasAuthForProvider = (
  provider: string,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
) => {
  if (!cfg || !authStore) {
    return false;
  }
  if (listProfilesForProvider(authStore, provider).length > 0) {
    return true;
  }
  if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
};

function createAvailabilityUnavailableError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = MODEL_AVAILABILITY_UNAVAILABLE_CODE;
  return err;
}

function normalizeAvailabilityError(err: unknown): Error {
  if (shouldFallbackToAuthHeuristics(err) && err instanceof Error) {
    return err;
  }
  return createAvailabilityUnavailableError(
    `Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`,
  );
}

function validateAvailableModels(availableModels: unknown): Model<Api>[] {
  if (!Array.isArray(availableModels)) {
    throw createAvailabilityUnavailableError(
      "Model availability unavailable: getAvailable() returned a non-array value.",
    );
  }

  for (const model of availableModels) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as { provider?: unknown }).provider !== "string" ||
      typeof (model as { id?: unknown }).id !== "string"
    ) {
      throw createAvailabilityUnavailableError(
        "Model availability unavailable: getAvailable() returned invalid model entries.",
      );
    }
  }

  return availableModels as Model<Api>[];
}

async function loadAvailableModels(
  registry: ModelRegistry,
  cfg: OpenClawConfig,
): Promise<Model<Api>[]> {
  let availableModels: unknown;
  try {
    availableModels = registry.getAvailable();
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
  try {
    const validated = validateAvailableModels(availableModels);
    const filtered: Model<Api>[] = [];
    for (const model of validated) {
      if (
        !(await shouldSuppressBuiltInModelAsync({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: cfg,
        }))
      ) {
        filtered.push(model);
      }
    }
    return filtered;
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
}

export async function loadModelRegistry(
  cfg: OpenClawConfig,
  _opts?: { sourceConfig?: OpenClawConfig },
) {
  const agentDir = resolveOpenClawAgentDir();
  const authStorage = await discoverAuthStorageAsync(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = (
    await Promise.all(
      registry.getAll().map(async (model) =>
        (await shouldSuppressBuiltInModelAsync({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: cfg,
        }))
          ? null
          : model,
      ),
    )
  ).filter((model): model is Model<Api> => model !== null);
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  try {
    const availableModels = await loadAvailableModels(registry, cfg);
    availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
  } catch (err) {
    if (!shouldFallbackToAuthHeuristics(err)) {
      throw err;
    }

    // Some providers can report model-level availability as unavailable.
    // Fall back to provider-level auth heuristics when availability is undefined.
    availableKeys = undefined;
    if (!availabilityErrorMessage) {
      availabilityErrorMessage = formatErrorWithStack(err);
    }
  }
  return { registry, models, availableKeys, availabilityErrorMessage };
}

export function toModelRow(params: Parameters<typeof toModelRowBase>[0]): ModelRow {
  return toModelRowBase({
    ...params,
    hasAuthForProvider: ({ provider, cfg, authStore }) =>
      hasAuthForProvider(provider, cfg, authStore),
  });
}
