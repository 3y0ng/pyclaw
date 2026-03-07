import { describe, expect, it } from "vitest";
import { buildRankedDiagnosis } from "./diagnose.js";

describe("buildRankedDiagnosis", () => {
  it("returns ranked findings with evidence/actions/confidence/validation", () => {
    const diagnosis = buildRankedDiagnosis({
      dailySnapshot: {
        date: "2026-03-01",
        totals: {
          spend: 100,
          impressions: 1000,
          clicks: 50,
          conversions: 0,
          ctr: 0.05,
          cpc: 2,
          cpa: 0,
        },
        byPlatform: [],
      },
      weeklyRollup: {
        currentWeek: {
          spend: 100,
          impressions: 1000,
          clicks: 50,
          conversions: 4,
          ctr: 0.05,
          cpa: 25,
        },
        previousWeek: {
          spend: 80,
          impressions: 900,
          clicks: 45,
          conversions: 8,
          ctr: 0.05,
          cpa: 10,
        },
        deltas: {
          spendPct: 0.25,
          clicksPct: 0.11,
          conversionsPct: -0.5,
          ctrPct: 0,
          cpaPct: 1.5,
        },
      },
      leaderboard: [
        {
          rank: 1,
          adId: "ad-1",
          platform: "meta",
          name: "Winner",
          spend: 40,
          clicks: 30,
          conversions: 3,
          ctr: 0.1,
          cpa: 13.33,
        },
      ],
      budgetAllocation: [
        {
          platform: "meta",
          spend: 80,
          spendSharePct: 0.8,
          conversions: 2,
          conversionSharePct: 0.4,
          efficiency: 0.1,
        },
      ],
    });

    expect(diagnosis.length).toBeGreaterThan(0);
    expect(diagnosis[0]?.rank).toBe(1);
    expect(diagnosis[0]?.evidence.length).toBeGreaterThan(0);
    expect(diagnosis[0]?.actions.length).toBeGreaterThan(0);
    expect(diagnosis[0]?.confidence).toBeGreaterThan(0);
    expect(diagnosis[0]?.validation.length).toBeGreaterThan(0);
  });
});
