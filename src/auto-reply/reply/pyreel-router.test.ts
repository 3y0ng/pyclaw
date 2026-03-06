import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { routePyreelMessage } from "./pyreel-router.js";
import { buildTestCtx } from "./test-ctx.js";

describe("routePyreelMessage", () => {
  it("passes through when pyreel mode is disabled", () => {
    const decision = routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "hello" }),
      cfg: {} as OpenClawConfig,
    });

    expect(decision.path).toBe("passthrough");
    expect(decision.reason).toBe("pyreel_mode_disabled");
  });

  it("blocks non-/pyreel input when mode is enabled", () => {
    const decision = routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "hello" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.deniedReason).toBe("non_pyreel_input");
  });

  it("handles /pyreel status from shared command path", () => {
    const decision = routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel status" }),
      cfg: {
        pyreel: { mode: true, features: { ingest: true, remix: false, export: true } },
      } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("status");
    if (decision.path === "block") {
      expect(decision.replyText).toContain("ingest=on");
      expect(decision.replyText).toContain("remix=off");
      expect(decision.replyText).toContain("export=on");
    }
  });

  it("denies disabled feature command", () => {
    const decision = routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel remix" }),
      cfg: { pyreel: { mode: true, features: { remix: false } } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("remix");
    expect(decision.deniedReason).toBe("feature_disabled");
  });
});
