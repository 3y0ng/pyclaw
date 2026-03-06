import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executePyreelWorkflow, type PyreelWorkflowAction } from "./pyreel-workflow.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-workflow-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const cases: Array<{ action: PyreelWorkflowAction; heading: string }> = [
  { action: "brief", heading: "# Pyreel Brief" },
  { action: "plan", heading: "# Pyreel Plan" },
  { action: "research", heading: "# Pyreel Research" },
  { action: "scripts", heading: "# Pyreel Scripts" },
  { action: "report", heading: "# Pyreel Report" },
  { action: "next", heading: "# Pyreel Next" },
];

describe("executePyreelWorkflow", () => {
  for (const testCase of cases) {
    it(`writes ${testCase.action} artifact with stable heading in workspace artifacts directory`, async () => {
      const workspaceDir = await createWorkspace();
      let seenAllowedTools: string[] | undefined;

      const result = await executePyreelWorkflow({
        action: testCase.action,
        request: "Ship this milestone",
        workspaceDir,
        runner: async (params) => {
          seenAllowedTools = params.allowedTools;
          return `${params.action.toUpperCase()} draft body`;
        },
      });

      expect(result.relativeArtifactPath.startsWith(".pyreel/artifacts/")).toBe(true);
      const artifactPath = path.join(workspaceDir, result.relativeArtifactPath);
      const artifactContent = await fs.readFile(artifactPath, "utf8");
      expect(artifactContent).toContain(testCase.heading);
      expect(artifactContent).toContain("## Output");
      expect(result.summary).toContain(result.relativeArtifactPath);
      expect(seenAllowedTools).toEqual([]);
    });
  }
});
