import type {
  DateRange,
  NormalizedAd,
  NormalizedCampaign,
  NormalizedMetricsSummary,
  PlatformExtras,
  PyreelAdsPlatform,
  ReadMetricsParams,
} from "./types.js";

export function isFeatureFlagEnabled(flagName: string): boolean {
  return process.env[flagName] === "1";
}

export function assertConnectorEnabled(platform: PyreelAdsPlatform, enabled: boolean): void {
  if (!enabled) {
    throw new Error(`Pyreel ${platform} connector is disabled.`);
  }
}

export function normalizeDateRange(params: DateRange): DateRange {
  return {
    startDate: String(params.startDate ?? "").trim(),
    endDate: String(params.endDate ?? "").trim(),
  };
}

export function normalizeCampaign(params: {
  platform: PyreelAdsPlatform;
  campaignId: string;
  name?: string;
  status?: string;
  extras?: PlatformExtras;
}): NormalizedCampaign {
  return {
    platform: params.platform,
    campaignId: String(params.campaignId),
    name: String(params.name ?? ""),
    status: String(params.status ?? "unknown"),
    platformExtras: {
      [params.platform]: params.extras ?? {},
    },
  };
}

export function normalizeAd(params: {
  platform: PyreelAdsPlatform;
  adId: string;
  campaignId?: string;
  name?: string;
  status?: string;
  extras?: PlatformExtras;
}): NormalizedAd {
  return {
    platform: params.platform,
    adId: String(params.adId),
    campaignId: params.campaignId ? String(params.campaignId) : undefined,
    name: String(params.name ?? ""),
    status: String(params.status ?? "unknown"),
    platformExtras: {
      [params.platform]: params.extras ?? {},
    },
  };
}

export function normalizeMetrics(params: {
  platform: PyreelAdsPlatform;
  dateRange: DateRange;
  impressions?: number | string;
  clicks?: number | string;
  spend?: number | string;
  conversions?: number | string;
  campaignId?: string;
  adId?: string;
  extras?: PlatformExtras;
}): NormalizedMetricsSummary {
  const dateRange = normalizeDateRange(params.dateRange);
  return {
    platform: params.platform,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    impressions: toNumber(params.impressions),
    clicks: toNumber(params.clicks),
    spend: toNumber(params.spend),
    conversions: toNumber(params.conversions),
    campaignId: params.campaignId ? String(params.campaignId) : undefined,
    adId: params.adId ? String(params.adId) : undefined,
    platformExtras: {
      [params.platform]: params.extras ?? {},
    },
  };
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export type ConnectorJsonRequest = (params: {
  path: string;
  query?: Record<string, string | undefined>;
}) => Promise<unknown>;

export type CreateConnectorCommonParams = {
  enabled?: boolean;
  requestJson: ConnectorJsonRequest;
};

export function buildMetricsQuery(params: ReadMetricsParams): Record<string, string | undefined> {
  return {
    startDate: params.startDate,
    endDate: params.endDate,
    campaignId: params.campaignId,
    adId: params.adId,
  };
}
