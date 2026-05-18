import fs from "node:fs";
import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { getRuntimeConfig } from "../config/config.js";

export type GatewayModelChoice = ModelCatalogEntry;

const gatewaySessionsTimingEnabled = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING === "1";
const gatewaySessionsTimingFile = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING_FILE?.trim();

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  const startMs = Date.now();
  const catalog = await loadModelCatalog({ config: (params?.getConfig ?? getRuntimeConfig)() });
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

// Stage 4 compat stub: upstream lets a config write force a model catalog
// reload at the gateway boundary. Locally the catalog reloads on demand, so
// this stub is a no-op; tests that mock it remain unaffected.
export function markGatewayModelCatalogStaleForReload(_reason?: string): void {
  // intentionally no-op
}
