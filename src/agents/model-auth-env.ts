import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { resolvePluginSetupProvider, resolvePluginSetupProviderAsync } from "../plugins/setup-registry.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveProviderEnvApiKeyCandidates } from "./model-auth-env-vars.js";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "./model-auth-markers.js";
import { resolveProviderIdForAuth, resolveProviderIdForAuthAsync } from "./provider-auth-aliases.js";

export type EnvApiKeyResult = {
  apiKey: string;
  source: string;
};

function hasGoogleVertexAdcCredentials(env: NodeJS.ProcessEnv): boolean {
  const explicitCredentialsPath = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicitCredentialsPath) {
    return fs.existsSync(explicitCredentialsPath);
  }
  const homeDir = normalizeOptionalSecretInput(env.HOME) ?? os.homedir();
  return fs.existsSync(
    path.join(homeDir, ".config", "gcloud", "application_default_credentials.json"),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasGoogleVertexAdcCredentialsAsync(env: NodeJS.ProcessEnv): Promise<boolean> {
  const explicitCredentialsPath = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicitCredentialsPath) {
    return pathExists(explicitCredentialsPath);
  }
  const homeDir = normalizeOptionalSecretInput(env.HOME) ?? os.homedir();
  return pathExists(
    path.join(homeDir, ".config", "gcloud", "application_default_credentials.json"),
  );
}

function resolveGoogleVertexEnvApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const explicitApiKey = normalizeOptionalSecretInput(env.GOOGLE_CLOUD_API_KEY);
  if (explicitApiKey) {
    return explicitApiKey;
  }
  const hasProject = Boolean(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
  const hasLocation = Boolean(env.GOOGLE_CLOUD_LOCATION);
  return hasProject && hasLocation && hasGoogleVertexAdcCredentials(env)
    ? GCP_VERTEX_CREDENTIALS_MARKER
    : undefined;
}

async function resolveGoogleVertexEnvApiKeyAsync(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const explicitApiKey = normalizeOptionalSecretInput(env.GOOGLE_CLOUD_API_KEY);
  if (explicitApiKey) {
    return explicitApiKey;
  }
  const hasProject = Boolean(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
  const hasLocation = Boolean(env.GOOGLE_CLOUD_LOCATION);
  return hasProject && hasLocation && (await hasGoogleVertexAdcCredentialsAsync(env))
    ? GCP_VERTEX_CREDENTIALS_MARKER
    : undefined;
}

export function resolveEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvApiKeyResult | null {
  const normalized = resolveProviderIdForAuth(provider, { env });
  const candidateMap = resolveProviderEnvApiKeyCandidates({ env });
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = normalizeOptionalSecretInput(env[envVar]);
    if (!value) {
      return null;
    }
    const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  const candidates = Object.hasOwn(candidateMap, normalized) ? candidateMap[normalized] : undefined;
  if (Array.isArray(candidates)) {
    for (const envVar of candidates) {
      const resolved = pick(envVar);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (normalized === "google-vertex") {
    const envKey = resolveGoogleVertexEnvApiKey(env);
    if (!envKey) {
      return null;
    }
    return { apiKey: envKey, source: "gcloud adc" };
  }

  const setupProvider = resolvePluginSetupProvider({
    provider: normalized,
    env,
  });
  if (setupProvider?.resolveConfigApiKey) {
    const resolved = setupProvider.resolveConfigApiKey({
      provider: normalized,
      env,
    });
    if (resolved?.trim()) {
      return {
        apiKey: resolved,
        source: resolved === GCP_VERTEX_CREDENTIALS_MARKER ? "gcloud adc" : "env",
      };
    }
  }

  return null;
}

export async function resolveEnvApiKeyAsync(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvApiKeyResult | null> {
  const normalized = await resolveProviderIdForAuthAsync(provider, { env });
  const candidateMap = resolveProviderEnvApiKeyCandidates({ env });
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = normalizeOptionalSecretInput(env[envVar]);
    if (!value) {
      return null;
    }
    const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  const candidates = Object.hasOwn(candidateMap, normalized) ? candidateMap[normalized] : undefined;
  if (Array.isArray(candidates)) {
    for (const envVar of candidates) {
      const resolved = pick(envVar);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (normalized === "google-vertex") {
    const envKey = await resolveGoogleVertexEnvApiKeyAsync(env);
    if (!envKey) {
      return null;
    }
    return { apiKey: envKey, source: "gcloud adc" };
  }

  const setupProvider = await resolvePluginSetupProviderAsync({
    provider: normalized,
    env,
  });
  if (setupProvider?.resolveConfigApiKey) {
    const resolved = setupProvider.resolveConfigApiKey({
      provider: normalized,
      env,
    });
    if (resolved?.trim()) {
      return {
        apiKey: resolved,
        source: resolved === GCP_VERTEX_CREDENTIALS_MARKER ? "gcloud adc" : "env",
      };
    }
  }

  return null;
}
