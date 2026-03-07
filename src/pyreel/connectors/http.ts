import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { buildRemoteBaseUrlPolicy } from "../../memory/remote-http.js";

type RequestParams = {
  baseUrl: string;
  path: string;
  accessToken: string;
  query?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export async function requestJsonWithGuard(params: RequestParams): Promise<unknown> {
  const url = new URL(params.path, params.baseUrl);
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    fetchImpl: params.fetchImpl,
    policy: buildRemoteBaseUrlPolicy(params.baseUrl),
    auditContext: "pyreel-connector",
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    },
  });

  try {
    if (!response.ok) {
      throw new Error(`Connector request failed (${response.status})`);
    }
    return await response.json();
  } finally {
    await release();
  }
}
