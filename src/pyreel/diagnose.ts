import type {
  BudgetAllocationEntry,
  CreativeLeaderboardEntry,
  PyreelDailySnapshot,
  PyreelWeeklyRollup,
} from "./reporting.js";

export type RankedDiagnosis = {
  rank: number;
  title: string;
  evidence: string;
  actions: string[];
  confidence: number;
  validation: string;
};

export function buildRankedDiagnosis(params: {
  dailySnapshot: PyreelDailySnapshot;
  weeklyRollup: PyreelWeeklyRollup;
  leaderboard: CreativeLeaderboardEntry[];
  budgetAllocation: BudgetAllocationEntry[];
}): RankedDiagnosis[] {
  const findings: RankedDiagnosis[] = [];

  if (params.weeklyRollup.deltas.conversionsPct < -0.15) {
    findings.push({
      rank: 0,
      title: "Conversion momentum is down week-over-week",
      evidence: `Conversions changed ${(params.weeklyRollup.deltas.conversionsPct * 100).toFixed(1)}% while spend changed ${(params.weeklyRollup.deltas.spendPct * 100).toFixed(1)}%.`,
      actions: [
        "Shift 10-20% of spend from lowest-converting platform to top creative cluster.",
        "Refresh first 3 seconds of underperforming creatives this week.",
      ],
      confidence: 0.82,
      validation:
        "Validate after 3 days: daily conversions should recover to prior-week pace at same or lower CPA.",
    });
  }

  const topAllocation = params.budgetAllocation[0];
  if (
    topAllocation &&
    topAllocation.spendSharePct > 0.65 &&
    topAllocation.conversionSharePct < 0.5
  ) {
    findings.push({
      rank: 0,
      title: "Budget concentration is too high for delivered conversion share",
      evidence: `${topAllocation.platform} uses ${(topAllocation.spendSharePct * 100).toFixed(1)}% of spend but contributes ${(topAllocation.conversionSharePct * 100).toFixed(1)}% of conversions.`,
      actions: [
        "Cap platform budget growth until conversion share catches up.",
        "Reallocate 15% of that platform budget to second-best efficiency platform.",
      ],
      confidence: 0.76,
      validation:
        "Validate over next 7 days: blended CPA should decrease and conversion share should rebalance.",
    });
  }

  const winner = params.leaderboard[0];
  if (winner && winner.conversions >= 2) {
    findings.push({
      rank: 0,
      title: "A scalable creative winner is available",
      evidence: `#1 creative (${winner.name}) produced ${winner.conversions.toFixed(1)} conversions at CPA ${winner.cpa.toFixed(2)}.`,
      actions: [
        "Clone winner into 2-3 variant hooks while keeping CTA constant.",
        "Increase winner ad set budget by 20% with daily spend cap.",
      ],
      confidence: 0.71,
      validation:
        "Validate in 72 hours: maintain or improve CPA while raising total conversion volume.",
    });
  }

  if (params.dailySnapshot.totals.clicks > 0 && params.dailySnapshot.totals.conversions === 0) {
    findings.push({
      rank: 0,
      title: "Traffic is landing without conversions",
      evidence: `Daily snapshot shows ${params.dailySnapshot.totals.clicks.toFixed(0)} clicks and 0 conversions.`,
      actions: [
        "Audit landing page friction and form completion issues.",
        "Add channel-specific post-click event tracking and verify attribution windows.",
      ],
      confidence: 0.67,
      validation:
        "Validate by tomorrow: first conversion events should appear for each active platform.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      rank: 0,
      title: "Performance is stable with no critical anomalies",
      evidence: "No major week-over-week degradation or allocation imbalance was detected.",
      actions: [
        "Continue current allocation with incremental creative testing.",
        "Track CTR and CPA guardrails daily to catch early drift.",
      ],
      confidence: 0.58,
      validation: "Validate weekly: maintain conversions and keep CPA within target band.",
    });
  }

  return findings
    .toSorted((a, b) => b.confidence - a.confidence)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
