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

const GOOGLE_ENABLED_ENV = "PYREEL_ENABLE_GOOGLE";

type GoogleCampaign = {
  campaignId: string;
  campaignName?: string;
  status?: string;
  advertisingChannelType?: string;
};
type GoogleAd = {
  adId: string;
  campaignId?: string;
  adName?: string;
  status?: string;
  adGroupId?: string;
};
type GoogleMetric = {
  campaignId?: string;
  adId?: string;
  impressions?: number | string;
  clicks?: number | string;
  costMicros?: number | string;
  conversions?: number | string;
  averageCpcMicros?: number | string;
};

export function createGoogleConnector(params: CreateConnectorCommonParams): PyreelAdsConnector {
  const enabled = params.enabled ?? isFeatureFlagEnabled(GOOGLE_ENABLED_ENV);

  return {
    platform: "google",
    isEnabled: () => enabled,
    readCampaigns: async () => {
      assertConnectorEnabled("google", enabled);
      const payload = (await params.requestJson({ path: "/campaigns" })) as {
        rows?: GoogleCampaign[];
      };
      return (payload.rows ?? []).map((item) =>
        normalizeCampaign({
          platform: "google",
          campaignId: item.campaignId,
          name: item.campaignName,
          status: item.status,
          extras: { advertisingChannelType: item.advertisingChannelType ?? null },
        }),
      );
    },
    readAds: async () => {
      assertConnectorEnabled("google", enabled);
      const payload = (await params.requestJson({ path: "/ads" })) as { rows?: GoogleAd[] };
      return (payload.rows ?? []).map((item) =>
        normalizeAd({
          platform: "google",
          adId: item.adId,
          campaignId: item.campaignId,
          name: item.adName,
          status: item.status,
          extras: { adGroupId: item.adGroupId ?? null },
        }),
      );
    },
    readMetricsSummary: async (dateRange) => {
      assertConnectorEnabled("google", enabled);
      const payload = (await params.requestJson({
        path: "/metrics/summary",
        query: buildMetricsQuery(dateRange),
      })) as { rows?: GoogleMetric[] };
      return (payload.rows ?? []).map((item) =>
        normalizeMetrics({
          platform: "google",
          dateRange,
          campaignId: item.campaignId,
          adId: item.adId,
          impressions: item.impressions,
          clicks: item.clicks,
          spend: Number(item.costMicros ?? 0) / 1_000_000,
          conversions: item.conversions,
          extras: { averageCpc: Number(item.averageCpcMicros ?? 0) / 1_000_000 },
        }),
      );
    },
  };
}
