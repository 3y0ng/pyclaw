import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import {
  executePyreelWorkflow,
  type PyreelWorkflowAction,
  type RestrictedPyreelModelRunner,
} from "./pyreel-workflow.js";

const PYREEL_HELP_TEXT =
  "Pyreel mode: use /pyreel help, /pyreel status, /pyreel ingest, /pyreel remix, /pyreel export, /pyreel brief, /pyreel plan, /pyreel research, /pyreel scripts, /pyreel report, or /pyreel next.";

type PyreelCommand = "help" | "status" | "ingest" | "remix" | "export" | PyreelWorkflowAction;

type PyreelRouterPassthroughDecision = {
  path: "passthrough";
  matchedCommand: null;
  deniedReason: null;
  reason: "pyreel_mode_disabled";
};

type PyreelRouterBlockDecision = {
  path: "block";
  matchedCommand: PyreelCommand | null;
  deniedReason: "non_pyreel_input" | "unknown_command" | "feature_disabled" | null;
  reason: "pyreel_mode_enforced";
  replyText: string;
};

export type PyreelRouterDecision = PyreelRouterPassthroughDecision | PyreelRouterBlockDecision;

const resolveInboundText = (ctx: FinalizedMsgContext): string => {
  const inboundBody = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  return inboundBody.trim();
};

const featureEnabled = (cfg: OpenClawConfig, feature: "ingest" | "remix" | "export"): boolean =>
  cfg.pyreel?.features?.[feature] !== false;

const WORKFLOW_ACTIONS = new Set<PyreelWorkflowAction>([
  "brief",
  "plan",
  "research",
  "scripts",
  "report",
  "next",
]);

export async function routePyreelMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  restrictedModelRunner?: RestrictedPyreelModelRunner;
}): Promise<PyreelRouterDecision> {
  const { ctx, cfg } = params;
  if (cfg.pyreel?.mode !== true) {
    return {
      path: "passthrough",
      matchedCommand: null,
      deniedReason: null,
      reason: "pyreel_mode_disabled",
    };
  }

  const inboundText = resolveInboundText(ctx);
  const parsed = parseSlashCommandOrNull(inboundText, "/pyreel", {
    invalidMessage: PYREEL_HELP_TEXT,
    defaultAction: "help",
  });

  if (!parsed) {
    return {
      path: "block",
      matchedCommand: null,
      deniedReason: "non_pyreel_input",
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (!parsed.ok) {
    return {
      path: "block",
      matchedCommand: null,
      deniedReason: "unknown_command",
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  const action = parsed.action;
  if (action === "help") {
    return {
      path: "block",
      matchedCommand: "help",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (action === "status") {
    const ingestEnabled = featureEnabled(cfg, "ingest") ? "on" : "off";
    const remixEnabled = featureEnabled(cfg, "remix") ? "on" : "off";
    const exportEnabled = featureEnabled(cfg, "export") ? "on" : "off";
    return {
      path: "block",
      matchedCommand: "status",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `Pyreel status: ingest=${ingestEnabled}, remix=${remixEnabled}, export=${exportEnabled}.`,
    };
  }

  if (action === "ingest" || action === "remix" || action === "export") {
    if (!featureEnabled(cfg, action)) {
      return {
        path: "block",
        matchedCommand: action,
        deniedReason: "feature_disabled",
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel ${action} is disabled in config.`,
      };
    }
    return {
      path: "block",
      matchedCommand: action,
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `Pyreel ${action} command received.`,
    };
  }

  if (WORKFLOW_ACTIONS.has(action as PyreelWorkflowAction)) {
    const workflowAction = action as PyreelWorkflowAction;
    const workspaceDir = params.workspaceDir?.trim();
    if (!workspaceDir) {
      return {
        path: "block",
        matchedCommand: workflowAction,
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel ${workflowAction} requires a workspace directory.`,
      };
    }

    const artifact = await executePyreelWorkflow({
      action: workflowAction,
      request: parsed.args,
      workspaceDir,
      runner: params.restrictedModelRunner,
    });

    return {
      path: "block",
      matchedCommand: workflowAction,
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: artifact.summary,
    };
  }

  return {
    path: "block",
    matchedCommand: null,
    deniedReason: "unknown_command",
    reason: "pyreel_mode_enforced",
    replyText: PYREEL_HELP_TEXT,
  };
}
