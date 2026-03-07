export type PyreelAdsPlatform = "meta" | "tiktok" | "google";

export type PlatformExtras = Record<string, string | number | boolean | null>;

export type NormalizedMetricsRequiredFields = {
  platform: PyreelAdsPlatform;
  startDate: string;
  endDate: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
};

export type NormalizedMetricsSummary = NormalizedMetricsRequiredFields & {
  campaignId?: string;
  adId?: string;
  platformExtras: Partial<Record<PyreelAdsPlatform, PlatformExtras>>;
};

export type NormalizedCampaign = {
  platform: PyreelAdsPlatform;
  campaignId: string;
  name: string;
  status: string;
  platformExtras: Partial<Record<PyreelAdsPlatform, PlatformExtras>>;
};

export type NormalizedAd = {
  platform: PyreelAdsPlatform;
  adId: string;
  campaignId?: string;
  name: string;
  status: string;
  platformExtras: Partial<Record<PyreelAdsPlatform, PlatformExtras>>;
};

export type DateRange = {
  startDate: string;
  endDate: string;
};

export type ReadMetricsParams = DateRange & {
  campaignId?: string;
  adId?: string;
};

export type PyreelAdsConnector = {
  platform: PyreelAdsPlatform;
  isEnabled: () => boolean;
  readCampaigns: () => Promise<NormalizedCampaign[]>;
  readAds: () => Promise<NormalizedAd[]>;
  readMetricsSummary: (params: ReadMetricsParams) => Promise<NormalizedMetricsSummary[]>;
};
