import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools pyreel mode filtering", () => {
  it("removes restricted network/runtime tools and blocks exec/process calls", async () => {
    const config: OpenClawConfig = {
      pyreel: { mode: true },
      tools: {
        allow: ["read", "exec", "process", "web_fetch", "web_search"],
      },
    };

    const tools = createOpenClawCodingTools({
      config,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    });

    const names = tools.map((tool) => tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("process");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("browser");

    const execTool = tools.find((tool) => tool.name === "exec");
    const processTool = tools.find((tool) => tool.name === "process");
    await expect(execTool?.execute("tc-pyreel-exec", { command: "echo hi" })).rejects.toThrow(
      "Tool blocked in Pyreel mode.",
    );
    await expect(processTool?.execute("tc-pyreel-process", { operation: "list" })).rejects.toThrow(
      "Tool blocked in Pyreel mode.",
    );
  });

  it("keeps tool assembly unchanged when pyreel mode is disabled", () => {
    const baseConfig: OpenClawConfig = {
      tools: {
        allow: ["read", "exec", "process", "web_fetch", "web_search"],
      },
    };

    const pyreelOffConfig: OpenClawConfig = {
      ...baseConfig,
      pyreel: { mode: false },
    };

    const baseline = createOpenClawCodingTools({
      config: baseConfig,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    }).map((tool) => tool.name);

    const pyreelOff = createOpenClawCodingTools({
      config: pyreelOffConfig,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    }).map((tool) => tool.name);

    expect(pyreelOff).toEqual(baseline);
  });
});
