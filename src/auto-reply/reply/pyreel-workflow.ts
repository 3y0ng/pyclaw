import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePyreelWorkspaceRelativePath,
  resolvePyreelWorkspacePath,
} from "./pyreel/workspace/paths.js";

export type PyreelWorkflowAction = "brief" | "plan" | "research" | "scripts" | "report" | "next";

export type RestrictedPyreelModelRunParams = {
  action: PyreelWorkflowAction;
  request: string;
  prompt: string;
  allowedTools: string[];
};

export type RestrictedPyreelModelRunner = (
  params: RestrictedPyreelModelRunParams,
) => Promise<string>;

const TEMPLATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "pyreel-workflow",
  "templates",
);

const ACTION_TITLES: Record<PyreelWorkflowAction, string> = {
  brief: "Brief",
  plan: "Plan",
  research: "Research",
  scripts: "Scripts",
  report: "Report",
  next: "Next",
};

function fillTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

const WORKFLOW_OUTPUT_DIR_BY_ACTION: Record<PyreelWorkflowAction, string> = {
  brief: "workflow/brief",
  plan: "workflow/plan",
  research: "workflow/research",
  scripts: "workflow/scripts",
  report: "workflow/report",
  next: "workflow/next",
};

const WORKFLOW_SECTIONS_BY_ACTION: Record<PyreelWorkflowAction, string[]> = {
  brief: ["Request", "Brief", "Assumptions", "Missing Info"],
  plan: ["Request", "Plan", "Assumptions", "Missing Info"],
  research: ["Request", "Research", "Assumptions", "Missing Info"],
  scripts: ["Request", "Scripts", "Assumptions", "Missing Info"],
  report: ["Request", "Report"],
  next: ["Request", "Next Steps", "Assumptions", "Missing Info"],
};

function parseTemplateHeadings(template: string): string[] {
  return template
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

function formatWorkflowFileName(action: PyreelWorkflowAction, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}_${action}.md`;
}

async function loadTemplate(action: PyreelWorkflowAction): Promise<string> {
  const filePath = path.join(TEMPLATE_DIR, `${action}.md`);
  return fs.readFile(filePath, "utf8");
}

async function runRestrictedModelTextGeneration(params: {
  action: PyreelWorkflowAction;
  request: string;
  prompt: string;
  runner?: RestrictedPyreelModelRunner;
}): Promise<string> {
  const runner =
    params.runner ??
    (async (runParams: RestrictedPyreelModelRunParams) => {
      const request = runParams.request.trim() || "No specific request provided.";
      return `Generated ${runParams.action} draft for: ${request}`;
    });

  return runner({
    action: params.action,
    request: params.request,
    prompt: params.prompt,
    allowedTools: [],
  });
}

export async function executePyreelWorkflow(params: {
  action: PyreelWorkflowAction;
  request: string;
  workspaceDir: string;
  runner?: RestrictedPyreelModelRunner;
}): Promise<{ summary: string; relativeArtifactPath: string; heading: string }> {
  const title = ACTION_TITLES[params.action];
  const template = await loadTemplate(params.action);
  const expectedSections = WORKFLOW_SECTIONS_BY_ACTION[params.action];
  const expectedHeadings = expectedSections;
  const actualHeadings = parseTemplateHeadings(template);
  if (actualHeadings.join("|") !== expectedHeadings.join("|")) {
    throw new Error(
      `Invalid template headings for ${params.action}. Expected [${expectedHeadings.join(", ")}], got [${actualHeadings.join(", ")}].`,
    );
  }

  const request = params.request.trim() || "No additional request provided.";
  const assumptions = "- _TBD_";
  const missingInfo = "- _TBD_";

  const prompt = fillTemplate(template, {
    action_title: title,
    request,
    generated_text: "",
    assumptions,
    missing_info: missingInfo,
  });

  const generatedText = await runRestrictedModelTextGeneration({
    action: params.action,
    request: params.request,
    prompt,
    runner: params.runner,
  });

  const output = fillTemplate(template, {
    action_title: title,
    request,
    generated_text: generatedText.trim(),
    assumptions,
    missing_info: missingInfo,
  }).trimEnd();

  const artifactFileName = formatWorkflowFileName(params.action, new Date());
  const artifactPath = resolvePyreelWorkspacePath(
    params.workspaceDir,
    path.join(WORKFLOW_OUTPUT_DIR_BY_ACTION[params.action], artifactFileName),
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${output}\n`, "utf8");

  const relativeArtifactPath = resolvePyreelWorkspaceRelativePath(
    params.workspaceDir,
    artifactPath,
  );
  return {
    summary: `${params.action}: ${relativeArtifactPath}`,
    relativeArtifactPath,
    heading: `# Pyreel ${title}`,
  };
}
