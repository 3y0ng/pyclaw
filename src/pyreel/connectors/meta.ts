import {
  assertConnectorEnabled,
  buildMetricsQuery,
  isFeatureFlagEnabled,
  normalizeAd,
  normalizeCampaign,
  normalizeMetrics,
  type CreateConnectorCommonParams,
} from "./shared.js";
import type { PyreelAdsConnector } from "./types.js";

const META_ENABLED_ENV = "PYREEL_ENABLE_META";

type MetaCampaign = { id: string; name?: string; status?: string; objective?: string };
type MetaAd = {
  id: string;
  campaign_id?: string;
  name?: string;
  status?: string;
  creative_id?: string;
};
type MetaMetric = {
  campaign_id?: string;
  ad_id?: string;
  impressions?: number | string;
  clicks?: number | string;
  spend?: number | string;
  conversions?: number | string;
  cpm?: number | string;
};

export function createMetaConnector(params: CreateConnectorCommonParams): PyreelAdsConnector {
  const enabled = params.enabled ?? isFeatureFlagEnabled(META_ENABLED_ENV);

  return {
    platform: "meta",
    isEnabled: () => enabled,
    readCampaigns: async () => {
      assertConnectorEnabled("meta", enabled);
      const payload = (await params.requestJson({ path: "/campaigns" })) as {
        data?: MetaCampaign[];
      };
      return (payload.data ?? []).map((item) =>
        normalizeCampaign({
          platform: "meta",
          campaignId: item.id,
          name: item.name,
          status: item.status,
          extras: { objective: item.objective ?? null },
        }),
      );
    },
    readAds: async () => {
      assertConnectorEnabled("meta", enabled);
      const payload = (await params.requestJson({ path: "/ads" })) as { data?: MetaAd[] };
      return (payload.data ?? []).map((item) =>
        normalizeAd({
          platform: "meta",
          adId: item.id,
          campaignId: item.campaign_id,
          name: item.name,
          status: item.status,
          extras: { creativeId: item.creative_id ?? null },
        }),
      );
    },
    readMetricsSummary: async (dateRange) => {
      assertConnectorEnabled("meta", enabled);
      const payload = (await params.requestJson({
        path: "/metrics/summary",
        query: buildMetricsQuery(dateRange),
      })) as { data?: MetaMetric[] };
      return (payload.data ?? []).map((item) =>
        normalizeMetrics({
          platform: "meta",
          dateRange,
          campaignId: item.campaign_id,
          adId: item.ad_id,
          impressions: item.impressions,
          clicks: item.clicks,
          spend: item.spend,
          conversions: item.conversions,
          extras: { cpm: Number(item.cpm ?? 0) },
        }),
      );
    },
  };
}
