import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("uses SOUL_PYREEL.md only when pyreel mode is enabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "default persona", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL_PYREEL.md"), "pyreel persona", "utf8");

    const pyreelOff = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: { pyreel: { mode: false } } as OpenClawConfig,
    });
    expect(pyreelOff.some((file) => file.name === "SOUL.md")).toBe(true);
    expect(pyreelOff.some((file) => file.name === "SOUL_PYREEL.md")).toBe(false);

    const pyreelOn = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: { pyreel: { mode: true } } as OpenClawConfig,
    });
    expect(pyreelOn.some((file) => file.name === "SOUL.md")).toBe(false);
    expect(pyreelOn.some((file) => file.name === "SOUL_PYREEL.md")).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("keeps bootstrap context within budget while selecting the mode-specific soul file", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "s".repeat(400), "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL_PYREEL.md"), "p".repeat(400), "utf8");

    const off = await resolveBootstrapContextForRun({
      workspaceDir,
      config: {
        pyreel: { mode: false },
        agents: { defaults: { bootstrapTotalMaxChars: 120 } },
      } as OpenClawConfig,
    });
    expect(off.bootstrapFiles.some((file) => file.name === "SOUL.md")).toBe(true);
    expect(off.bootstrapFiles.some((file) => file.name === "SOUL_PYREEL.md")).toBe(false);
    const offChars = off.contextFiles.reduce((total, file) => total + file.content.length, 0);
    expect(offChars).toBeLessThanOrEqual(120);

    const on = await resolveBootstrapContextForRun({
      workspaceDir,
      config: {
        pyreel: { mode: true },
        agents: { defaults: { bootstrapTotalMaxChars: 120 } },
      } as OpenClawConfig,
    });
    expect(on.bootstrapFiles.some((file) => file.name === "SOUL.md")).toBe(false);
    expect(on.bootstrapFiles.some((file) => file.name === "SOUL_PYREEL.md")).toBe(true);
    const onChars = on.contextFiles.reduce((total, file) => total + file.content.length, 0);
    expect(onChars).toBeLessThanOrEqual(120);
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toEqual([]);
  });
});
