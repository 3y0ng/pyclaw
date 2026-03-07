import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { createGoogleConnector } from "./google.js";
import { createMetaConnector } from "./meta.js";
import { createTikTokConnector } from "./tiktok.js";

describe("pyreel connectors normalization", () => {
  it("normalizes meta campaigns/ads/metrics", async () => {
    const connector = createMetaConnector({
      enabled: true,
      requestJson: async ({ path }) => {
        if (path === "/campaigns") {
          return {
            data: [{ id: "cmp_1", name: "Meta Campaign", status: "ACTIVE", objective: "SALES" }],
          };
        }
        if (path === "/ads") {
          return {
            data: [{ id: "ad_1", campaign_id: "cmp_1", name: "Meta Ad", status: "ACTIVE" }],
          };
        }
        return {
          data: [
            { campaign_id: "cmp_1", ad_id: "ad_1", impressions: "100", clicks: "10", spend: "5.5" },
          ],
        };
      },
    });

    await expect(connector.readCampaigns()).resolves.toMatchObject([
      { platform: "meta", campaignId: "cmp_1", name: "Meta Campaign", status: "ACTIVE" },
    ]);
    await expect(connector.readAds()).resolves.toMatchObject([
      { platform: "meta", adId: "ad_1", campaignId: "cmp_1", name: "Meta Ad" },
    ]);
    await expect(
      connector.readMetricsSummary({ startDate: "2026-01-01", endDate: "2026-01-31" }),
    ).resolves.toMatchObject([
      {
        platform: "meta",
        campaignId: "cmp_1",
        adId: "ad_1",
        impressions: 100,
        clicks: 10,
        spend: 5.5,
        conversions: 0,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
    ]);
  });

  it("normalizes tiktok and google metrics summaries", async () => {
    const tiktok = createTikTokConnector({
      enabled: true,
      requestJson: async () => ({
        list: [{ campaign_id: "ttc", impressions: "42", clicks: "4", spend: "9.1" }],
      }),
    });
    const google = createGoogleConnector({
      enabled: true,
      requestJson: async () => ({
        rows: [{ campaignId: "ggc", impressions: 50, clicks: 5, costMicros: 2100000 }],
      }),
    });

    const [ttSummary] = await tiktok.readMetricsSummary({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
    });
    const [ggSummary] = await google.readMetricsSummary({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
    });

    expect(ttSummary).toMatchObject({
      platform: "tiktok",
      campaignId: "ttc",
      spend: 9.1,
      impressions: 42,
    });
    expect(ggSummary).toMatchObject({
      platform: "google",
      campaignId: "ggc",
      spend: 2.1,
      impressions: 50,
    });
  });
});

describe("pyreel connector feature flags", () => {
  it("keeps connectors disabled when enable env flags are absent", async () => {
    await withEnvAsync(
      {
        PYREEL_ENABLE_META: undefined,
        PYREEL_ENABLE_TIKTOK: undefined,
        PYREEL_ENABLE_GOOGLE: undefined,
      },
      async () => {
        const meta = createMetaConnector({ requestJson: async () => ({}) });
        const tiktok = createTikTokConnector({ requestJson: async () => ({}) });
        const google = createGoogleConnector({ requestJson: async () => ({}) });

        expect(meta.isEnabled()).toBe(false);
        expect(tiktok.isEnabled()).toBe(false);
        expect(google.isEnabled()).toBe(false);

        await expect(meta.readCampaigns()).rejects.toThrow("disabled");
        await expect(tiktok.readAds()).rejects.toThrow("disabled");
        await expect(
          google.readMetricsSummary({ startDate: "2026-01-01", endDate: "2026-01-02" }),
        ).rejects.toThrow("disabled");
      },
    );
  });
});
