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

const TIKTOK_ENABLED_ENV = "PYREEL_ENABLE_TIKTOK";

type TikTokCampaign = {
  campaign_id: string;
  campaign_name?: string;
  operation_status?: string;
  objective_type?: string;
};
type TikTokAd = {
  ad_id: string;
  campaign_id?: string;
  ad_name?: string;
  operation_status?: string;
  adgroup_id?: string;
};
type TikTokMetric = {
  campaign_id?: string;
  ad_id?: string;
  impressions?: number | string;
  clicks?: number | string;
  spend?: number | string;
  conversions?: number | string;
  ctr?: number | string;
};

export function createTikTokConnector(params: CreateConnectorCommonParams): PyreelAdsConnector {
  const enabled = params.enabled ?? isFeatureFlagEnabled(TIKTOK_ENABLED_ENV);

  return {
    platform: "tiktok",
    isEnabled: () => enabled,
    readCampaigns: async () => {
      assertConnectorEnabled("tiktok", enabled);
      const payload = (await params.requestJson({ path: "/campaign/get" })) as {
        list?: TikTokCampaign[];
      };
      return (payload.list ?? []).map((item) =>
        normalizeCampaign({
          platform: "tiktok",
          campaignId: item.campaign_id,
          name: item.campaign_name,
          status: item.operation_status,
          extras: { objectiveType: item.objective_type ?? null },
        }),
      );
    },
    readAds: async () => {
      assertConnectorEnabled("tiktok", enabled);
      const payload = (await params.requestJson({ path: "/ad/get" })) as { list?: TikTokAd[] };
      return (payload.list ?? []).map((item) =>
        normalizeAd({
          platform: "tiktok",
          adId: item.ad_id,
          campaignId: item.campaign_id,
          name: item.ad_name,
          status: item.operation_status,
          extras: { adGroupId: item.adgroup_id ?? null },
        }),
      );
    },
    readMetricsSummary: async (dateRange) => {
      assertConnectorEnabled("tiktok", enabled);
      const payload = (await params.requestJson({
        path: "/report/integrated/get",
        query: buildMetricsQuery(dateRange),
      })) as { list?: TikTokMetric[] };
      return (payload.list ?? []).map((item) =>
        normalizeMetrics({
          platform: "tiktok",
          dateRange,
          campaignId: item.campaign_id,
          adId: item.ad_id,
          impressions: item.impressions,
          clicks: item.clicks,
          spend: item.spend,
          conversions: item.conversions,
          extras: { ctr: Number(item.ctr ?? 0) },
        }),
      );
    },
  };
}
