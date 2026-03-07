import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executePyreelWorkflow, type PyreelWorkflowAction } from "./pyreel-workflow.js";
import { resolvePyreelWorkspacePath } from "./pyreel/workspace/paths.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-workflow-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const cases: Array<{
  action: PyreelWorkflowAction;
  title: string;
  outputDir: string;
  sections: string[];
}> = [
  {
    action: "brief",
    title: "Brief",
    outputDir: "workflow/brief",
    sections: ["Request", "Brief", "Assumptions", "Missing Info"],
  },
  {
    action: "plan",
    title: "Plan",
    outputDir: "workflow/plan",
    sections: ["Request", "Plan", "Assumptions", "Missing Info"],
  },
  {
    action: "research",
    title: "Research",
    outputDir: "workflow/research",
    sections: ["Request", "Research", "Assumptions", "Missing Info"],
  },
  {
    action: "scripts",
    title: "Scripts",
    outputDir: "workflow/scripts",
    sections: ["Request", "Scripts", "Assumptions", "Missing Info"],
  },
  {
    action: "report",
    title: "Report",
    outputDir: "workflow/report",
    sections: ["Request", "Report"],
  },
  {
    action: "next",
    title: "Next",
    outputDir: "workflow/next",
    sections: ["Request", "Next Steps", "Assumptions", "Missing Info"],
  },
];

describe("executePyreelWorkflow", () => {
  for (const testCase of cases) {
    it(`writes ${testCase.action} artifact with stable section ordering and workspace path`, async () => {
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

      expect(result.relativeArtifactPath).toMatch(
        new RegExp(
          `^pyreel/workspace/${testCase.outputDir}/\\d{8}_\\d{4}_${testCase.action}\\.md$`,
        ),
      );
      expect(result.summary).toBe(`${testCase.action}: ${result.relativeArtifactPath}`);

      const artifactPath = path.join(workspaceDir, result.relativeArtifactPath);
      const artifactContent = await fs.readFile(artifactPath, "utf8");

      const headings = artifactContent
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3));
      expect(headings).toEqual(testCase.sections);

      expect(artifactContent).toMatchSnapshot();
      expect(result.heading).toBe(`# Pyreel ${testCase.title}`);
      expect(seenAllowedTools).toEqual([]);
    });
  }

  it("rejects absolute and traversal paths in workspace helper", async () => {
    const workspaceDir = await createWorkspace();
    expect(() => resolvePyreelWorkspacePath(workspaceDir, "../escape.md")).toThrow(
      "relativePath cannot contain '..'",
    );
    expect(() => resolvePyreelWorkspacePath(workspaceDir, "/tmp/escape.md")).toThrow(
      "relativePath must be relative",
    );
  });
});
