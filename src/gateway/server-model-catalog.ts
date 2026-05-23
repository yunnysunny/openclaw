import fs from "node:fs";
import { type ModelCatalogEntry, resetModelCatalogCacheForTest } from "../agents/model-catalog.js";
import { getRuntimeConfig } from "../config/config.js";

export type GatewayModelChoice = ModelCatalogEntry;

type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadModelCatalog = (params: {
  config: GatewayModelCatalogConfig;
  readOnly?: boolean;
}) => Promise<GatewayModelChoice[]>;
type LoadGatewayModelCatalogParams = {
  getConfig?: () => GatewayModelCatalogConfig;
  loadModelCatalog?: LoadModelCatalog;
  readOnly?: boolean;
};

type GatewayModelCatalogCache = {
  lastSuccessfulCatalog: GatewayModelChoice[] | null;
  inFlightRefresh: Promise<GatewayModelChoice[]> | null;
  staleGeneration: number;
  appliedGeneration: number;
};

const gatewaySessionsTimingEnabled = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING === "1";
const gatewaySessionsTimingFile = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING_FILE?.trim();

function createGatewayModelCatalogCache(): GatewayModelCatalogCache {
  return {
    lastSuccessfulCatalog: null,
    inFlightRefresh: null,
    staleGeneration: 0,
    appliedGeneration: 0,
  };
}

const readOnlyModelCatalogCache = createGatewayModelCatalogCache();
const fullModelCatalogCache = createGatewayModelCatalogCache();

function resolveGatewayModelCatalogCache(
  params?: LoadGatewayModelCatalogParams,
): GatewayModelCatalogCache {
  return params?.readOnly === false ? fullModelCatalogCache : readOnlyModelCatalogCache;
}

function resetGatewayModelCatalogState(): void {
  for (const cache of [readOnlyModelCatalogCache, fullModelCatalogCache]) {
    cache.lastSuccessfulCatalog = null;
    cache.inFlightRefresh = null;
    cache.staleGeneration = 0;
    cache.appliedGeneration = 0;
  }
}

function isGatewayModelCatalogStale(cache: GatewayModelCatalogCache): boolean {
  return cache.appliedGeneration < cache.staleGeneration;
}

async function resolveLoadModelCatalog(
  params?: LoadGatewayModelCatalogParams,
): Promise<LoadModelCatalog> {
  if (params?.loadModelCatalog) {
    return params.loadModelCatalog;
  }
  const { loadModelCatalog } = await import("../agents/model-catalog.js");
  return loadModelCatalog;
}

function startGatewayModelCatalogRefresh(
  params?: LoadGatewayModelCatalogParams,
): Promise<GatewayModelChoice[]> {
  const cache = resolveGatewayModelCatalogCache(params);
  const config = (params?.getConfig ?? getRuntimeConfig)();
  const readOnly = params?.readOnly !== false;
  const refreshGeneration = cache.staleGeneration;
  const refresh = resolveLoadModelCatalog(params)
    .then((loadModelCatalog) => loadModelCatalog({ config, readOnly }))
    .then((catalog) => {
      if ((readOnly || catalog.length > 0) && refreshGeneration === cache.staleGeneration) {
        cache.lastSuccessfulCatalog = catalog;
        cache.appliedGeneration = cache.staleGeneration;
      }
      return catalog;
    })
    .finally(() => {
      if (cache.inFlightRefresh === refresh) {
        cache.inFlightRefresh = null;
      }
    });
  cache.inFlightRefresh = refresh;
  return refresh;
}

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetGatewayModelCatalogState();
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
  loadModelCatalog?: LoadModelCatalog;
  readOnly?: boolean;
}): Promise<GatewayModelChoice[]> {
  const startMs = Date.now();
  const cache = resolveGatewayModelCatalogCache(params);
  const isStale = isGatewayModelCatalogStale(cache);
  let catalog: GatewayModelChoice[];
  if (!isStale && cache.lastSuccessfulCatalog !== null) {
    catalog = cache.lastSuccessfulCatalog;
  } else if (isStale && cache.lastSuccessfulCatalog !== null) {
    if (!cache.inFlightRefresh) {
      void startGatewayModelCatalogRefresh(params).catch(() => undefined);
    }
    catalog = cache.lastSuccessfulCatalog;
  } else if (cache.inFlightRefresh) {
    catalog = await cache.inFlightRefresh;
  } else {
    catalog = await startGatewayModelCatalogRefresh(params);
  }
  if (gatewaySessionsTimingEnabled) {
    const line = `[gateway-sessions-timing] stage=loadGatewayModelCatalog elapsedMs=${Date.now() - startMs} models=${catalog.length}`;
    console.error(line);
    if (gatewaySessionsTimingFile) {
      try {
        fs.appendFileSync(gatewaySessionsTimingFile, `${line}\n`, "utf8");
      } catch {
        // Diagnostic logging must not affect test behavior.
      }
    }
  }
  return catalog;
}

export function markGatewayModelCatalogStaleForReload(_reason?: string): void {
  readOnlyModelCatalogCache.staleGeneration += 1;
  fullModelCatalogCache.staleGeneration += 1;
}
