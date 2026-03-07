import { describe, expect, it } from "vitest";
import {
  buildBudgetAllocationSummary,
  buildCreativeLeaderboard,
  buildDailySnapshot,
  buildWeeklyRollup,
} from "./reporting.js";

const sampleMetrics = [
  {
    platform: "meta" as const,
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    campaignId: "cmp-1",
    adId: "ad-1",
    impressions: 1000,
    clicks: 100,
    spend: 200,
    conversions: 10,
    platformExtras: {},
  },
  {
    platform: "tiktok" as const,
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    campaignId: "cmp-2",
    adId: "ad-2",
    impressions: 500,
    clicks: 25,
    spend: 75,
    conversions: 5,
    platformExtras: {},
  },
];

describe("pyreel reporting", () => {
  it("builds a daily snapshot", () => {
    const snapshot = buildDailySnapshot({ date: "2026-03-01", metrics: sampleMetrics });
    expect(snapshot.totals.spend).toBe(275);
    expect(snapshot.totals.clicks).toBe(125);
    expect(snapshot.byPlatform).toHaveLength(2);
  });

  it("builds weekly rollup deltas", () => {
    const rollup = buildWeeklyRollup({
      currentWeekMetrics: sampleMetrics,
      previousWeekMetrics: [
        {
          ...sampleMetrics[0],
          spend: 100,
          clicks: 50,
          conversions: 5,
        },
      ],
    });

    expect(rollup.currentWeek.spend).toBe(275);
    expect(rollup.previousWeek.spend).toBe(100);
    expect(rollup.deltas.spendPct).toBeGreaterThan(1);
  });

  it("builds creative leaderboard and budget allocation", () => {
    const leaderboard = buildCreativeLeaderboard({
      ads: [
        {
          platform: "meta",
          adId: "ad-1",
          campaignId: "cmp-1",
          name: "Creative A",
          status: "ACTIVE",
          platformExtras: {},
        },
        {
          platform: "tiktok",
          adId: "ad-2",
          campaignId: "cmp-2",
          name: "Creative B",
          status: "ACTIVE",
          platformExtras: {},
        },
      ],
      metrics: sampleMetrics,
      limit: 2,
    });

    expect(leaderboard[0]?.name).toBe("Creative A");
    const allocation = buildBudgetAllocationSummary({ metrics: sampleMetrics });
    expect(allocation[0]?.spendSharePct).toBeGreaterThan(allocation[1]?.spendSharePct ?? 0);
  });
});
