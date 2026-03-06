import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { loadConfig } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("pyreel config env normalization", () => {
  it("defaults to disabled when flags are absent", async () => {
    await withEnvAsync(
      {
        PYREEL_MODE: undefined,
        PYREEL_FEATURE_INGEST: undefined,
        PYREEL_FEATURE_REMIX: undefined,
        PYREEL_FEATURE_EXPORT: undefined,
      },
      async () => {
        await withTempHome(async (home) => {
          await writeOpenClawConfig(home, {});

          const cfg = loadConfig();

          expect(cfg.pyreel).toBeUndefined();
        });
      },
    );
  });

  it("enables pyreel mode and features from env flags", async () => {
    await withEnvAsync(
      {
        PYREEL_MODE: "1",
        PYREEL_FEATURE_INGEST: "1",
        PYREEL_FEATURE_REMIX: "1",
        PYREEL_FEATURE_EXPORT: "0",
      },
      async () => {
        await withTempHome(async (home) => {
          await writeOpenClawConfig(home, {});

          const cfg = loadConfig();

          expect(cfg.pyreel?.mode).toBe(true);
          expect(cfg.pyreel?.features?.ingest).toBe(true);
          expect(cfg.pyreel?.features?.remix).toBe(true);
          expect(cfg.pyreel?.features?.export).toBe(false);
        });
      },
    );
  });

  it("fails safely when env flags are malformed", async () => {
    await withEnvAsync(
      {
        PYREEL_MODE: "true",
        PYREEL_FEATURE_INGEST: "yes",
        PYREEL_FEATURE_REMIX: "nope",
        PYREEL_FEATURE_EXPORT: "enabled",
      },
      async () => {
        await withTempHome(async (home) => {
          await writeOpenClawConfig(home, {});

          const cfg = loadConfig();

          expect(cfg.pyreel).toBeUndefined();
        });
      },
    );
  });
});
