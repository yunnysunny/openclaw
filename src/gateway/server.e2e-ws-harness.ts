import fs from "node:fs";
import { WebSocket } from "ws";
import { captureEnv } from "../test-utils/env.js";
import {
  connectOk,
  getFreePort,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

const gatewaySessionsTimingEnabled = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING === "1";
const gatewaySessionsTimingFile = process.env.OPENCLAW_DEBUG_GATEWAY_SESSIONS_TIMING_FILE?.trim();

function logGatewaySessionsTiming(stage: string, elapsedMs: number) {
  if (!gatewaySessionsTimingEnabled) {
    return;
  }
  const line = `[gateway-sessions-timing] stage=${stage} elapsedMs=${elapsedMs}`;
  console.error(line);
  if (gatewaySessionsTimingFile) {
    try {
      fs.appendFileSync(gatewaySessionsTimingFile, `${line}\n`, "utf8");
    } catch {
      // Diagnostic logging must not affect test behavior.
    }
  }
}

export type GatewayWsClient = {
  ws: WebSocket;
  hello: unknown;
};

export type GatewayServerHarness = {
  port: number;
  server: Awaited<ReturnType<typeof startGatewayServer>>;
  openClient: (opts?: Parameters<typeof connectOk>[1]) => Promise<GatewayWsClient>;
  close: () => Promise<void>;
};

export async function startGatewayServerHarness(): Promise<GatewayServerHarness> {
  const envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const port = await getFreePort();
  const server = await startGatewayServer(port, {
    auth: { mode: "none" },
    controlUiEnabled: false,
  });

  const openClient = async (opts?: Parameters<typeof connectOk>[1]): Promise<GatewayWsClient> => {
    const openClientStartMs = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    trackConnectChallengeNonce(ws);
    const wsOpenStartMs = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
      const onOpen = () => {
        clearTimeout(timer);
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    logGatewaySessionsTiming("openClient.ws-open", Date.now() - wsOpenStartMs);
    const connectStartMs = Date.now();
    const hello = await connectOk(ws, opts);
    logGatewaySessionsTiming("openClient.connect-ok", Date.now() - connectStartMs);
    logGatewaySessionsTiming("openClient.total", Date.now() - openClientStartMs);
    return { ws, hello };
  };

  const close = async () => {
    await server.close();
    envSnapshot.restore();
  };

  return { port, server, openClient, close };
}
