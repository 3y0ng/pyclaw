import type {
  NormalizedAd,
  NormalizedMetricsSummary,
  PyreelAdsPlatform,
} from "./connectors/types.js";

export type PyreelDailySnapshot = {
  date: string;
  totals: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpc: number;
    cpa: number;
  };
  byPlatform: Array<{
    platform: PyreelAdsPlatform;
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
  }>;
};

export type PyreelWeeklyRollup = {
  currentWeek: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
  };
  previousWeek: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpa: number;
  };
  deltas: {
    spendPct: number;
    clicksPct: number;
    conversionsPct: number;
    ctrPct: number;
    cpaPct: number;
  };
};

export type CreativeLeaderboardEntry = {
  rank: number;
  adId: string;
  platform: PyreelAdsPlatform;
  name: string;
  spend: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpa: number;
};

export type BudgetAllocationEntry = {
  platform: PyreelAdsPlatform;
  spend: number;
  spendSharePct: number;
  conversions: number;
  conversionSharePct: number;
  efficiency: number;
};

function sumMetrics(rows: NormalizedMetricsSummary[]) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.conversions += row.conversions;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
  );
  const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  const cpa = totals.conversions > 0 ? totals.spend / totals.conversions : 0;
  return { ...totals, ctr, cpc, cpa };
}

function pctDelta(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 1;
  }
  return (current - previous) / previous;
}

export function buildDailySnapshot(params: {
  date: string;
  metrics: NormalizedMetricsSummary[];
}): PyreelDailySnapshot {
  const totals = sumMetrics(params.metrics);
  const byPlatformMap = new Map<PyreelAdsPlatform, NormalizedMetricsSummary[]>();
  for (const metric of params.metrics) {
    byPlatformMap.set(metric.platform, [...(byPlatformMap.get(metric.platform) ?? []), metric]);
  }

  const byPlatform = [...byPlatformMap.entries()]
    .map(([platform, rows]) => {
      const summary = sumMetrics(rows);
      return {
        platform,
        spend: summary.spend,
        impressions: summary.impressions,
        clicks: summary.clicks,
        conversions: summary.conversions,
        ctr: summary.ctr,
      };
    })
    .toSorted((a, b) => b.spend - a.spend);

  return { date: params.date, totals, byPlatform };
}

export function buildWeeklyRollup(params: {
  currentWeekMetrics: NormalizedMetricsSummary[];
  previousWeekMetrics: NormalizedMetricsSummary[];
}): PyreelWeeklyRollup {
  const currentWeek = sumMetrics(params.currentWeekMetrics);
  const previousWeek = sumMetrics(params.previousWeekMetrics);

  return {
    currentWeek: {
      spend: currentWeek.spend,
      impressions: currentWeek.impressions,
      clicks: currentWeek.clicks,
      conversions: currentWeek.conversions,
      ctr: currentWeek.ctr,
      cpa: currentWeek.cpa,
    },
    previousWeek: {
      spend: previousWeek.spend,
      impressions: previousWeek.impressions,
      clicks: previousWeek.clicks,
      conversions: previousWeek.conversions,
      ctr: previousWeek.ctr,
      cpa: previousWeek.cpa,
    },
    deltas: {
      spendPct: pctDelta(currentWeek.spend, previousWeek.spend),
      clicksPct: pctDelta(currentWeek.clicks, previousWeek.clicks),
      conversionsPct: pctDelta(currentWeek.conversions, previousWeek.conversions),
      ctrPct: pctDelta(currentWeek.ctr, previousWeek.ctr),
      cpaPct: pctDelta(currentWeek.cpa, previousWeek.cpa),
    },
  };
}

export function buildCreativeLeaderboard(params: {
  ads: NormalizedAd[];
  metrics: NormalizedMetricsSummary[];
  limit?: number;
}): CreativeLeaderboardEntry[] {
  const adMap = new Map(params.ads.map((ad) => [ad.adId, ad]));
  const grouped = new Map<string, NormalizedMetricsSummary[]>();
  for (const metric of params.metrics) {
    if (!metric.adId) {
      continue;
    }
    grouped.set(metric.adId, [...(grouped.get(metric.adId) ?? []), metric]);
  }

  return [...grouped.entries()]
    .map(([adId, rows]) => {
      const totals = sumMetrics(rows);
      const ad = adMap.get(adId);
      return {
        rank: 0,
        adId,
        platform: rows[0]?.platform ?? ad?.platform ?? "meta",
        name: ad?.name ?? adId,
        spend: totals.spend,
        clicks: totals.clicks,
        conversions: totals.conversions,
        ctr: totals.ctr,
        cpa: totals.cpa,
      };
    })
    .toSorted((a, b) => {
      if (b.conversions !== a.conversions) {
        return b.conversions - a.conversions;
      }
      if (b.ctr !== a.ctr) {
        return b.ctr - a.ctr;
      }
      return a.cpa - b.cpa;
    })
    .slice(0, params.limit ?? 5)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function buildBudgetAllocationSummary(params: {
  metrics: NormalizedMetricsSummary[];
}): BudgetAllocationEntry[] {
  const totals = sumMetrics(params.metrics);
  const perPlatform = new Map<PyreelAdsPlatform, NormalizedMetricsSummary[]>();
  for (const metric of params.metrics) {
    perPlatform.set(metric.platform, [...(perPlatform.get(metric.platform) ?? []), metric]);
  }

  return [...perPlatform.entries()]
    .map(([platform, rows]) => {
      const summary = sumMetrics(rows);
      return {
        platform,
        spend: summary.spend,
        spendSharePct: totals.spend > 0 ? summary.spend / totals.spend : 0,
        conversions: summary.conversions,
        conversionSharePct: totals.conversions > 0 ? summary.conversions / totals.conversions : 0,
        efficiency: summary.cpa > 0 ? 1 / summary.cpa : 0,
      };
    })
    .toSorted((a, b) => b.spend - a.spend);
}
