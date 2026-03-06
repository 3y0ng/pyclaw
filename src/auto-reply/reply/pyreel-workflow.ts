import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function normalizeArtifactSegment(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, "-");
  return collapsed.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
}

function resolveArtifactName(action: PyreelWorkflowAction): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${action}-${iso}.md`;
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

  const prompt = fillTemplate(template, {
    action_title: title,
    request: params.request.trim() || "No additional request provided.",
    generated_text: "",
  });

  const generatedText = await runRestrictedModelTextGeneration({
    action: params.action,
    request: params.request,
    prompt,
    runner: params.runner,
  });

  const output = fillTemplate(template, {
    action_title: title,
    request: params.request.trim() || "No additional request provided.",
    generated_text: generatedText.trim(),
  }).trimEnd();

  const artifactsDir = path.join(params.workspaceDir, ".pyreel", "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifactFileName = resolveArtifactName(params.action);
  const artifactPath = path.join(artifactsDir, normalizeArtifactSegment(artifactFileName));
  await fs.writeFile(artifactPath, `${output}\n`, "utf8");

  const relativeArtifactPath =
    path.relative(params.workspaceDir, artifactPath) || path.basename(artifactPath);
  return {
    summary: `Pyreel ${params.action} ready: ${relativeArtifactPath}`,
    relativeArtifactPath,
    heading: `# Pyreel ${title}`,
  };
}
