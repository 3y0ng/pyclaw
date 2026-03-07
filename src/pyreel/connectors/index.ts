import { createGoogleConnector } from "./google.js";
import { requestJsonWithGuard } from "./http.js";
import { createMetaConnector } from "./meta.js";
import type { ConnectorJsonRequest } from "./shared.js";
import { createTikTokConnector } from "./tiktok.js";
import type { PyreelAdsConnector } from "./types.js";

export type ConnectorRuntimeConfig = {
  baseUrl: string;
  accessToken: string;
};

export function createConnectorRequestJson(config: ConnectorRuntimeConfig): ConnectorJsonRequest {
  return async (params) =>
    requestJsonWithGuard({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
      path: params.path,
      query: params.query,
    });
}

export function createPyreelAdsConnectors(params: {
  meta?: ConnectorRuntimeConfig;
  tiktok?: ConnectorRuntimeConfig;
  google?: ConnectorRuntimeConfig;
}): PyreelAdsConnector[] {
  const connectors: PyreelAdsConnector[] = [];

  if (params.meta) {
    connectors.push(createMetaConnector({ requestJson: createConnectorRequestJson(params.meta) }));
  }
  if (params.tiktok) {
    connectors.push(
      createTikTokConnector({ requestJson: createConnectorRequestJson(params.tiktok) }),
    );
  }
  if (params.google) {
    connectors.push(
      createGoogleConnector({ requestJson: createConnectorRequestJson(params.google) }),
    );
  }

  return connectors;
}

export * from "./types.js";
