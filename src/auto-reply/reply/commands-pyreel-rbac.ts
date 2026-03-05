import fs from "node:fs/promises";
import path from "node:path";

export type PyreelRole = "viewer" | "operator" | "approver" | "admin";

type PyreelAclGrant = {
  subject: string;
  role: PyreelRole;
};

type PyreelAclFile = {
  version: 1;
  defaultRole?: PyreelRole;
  grants?: PyreelAclGrant[];
};

const ROLE_ORDER: Record<PyreelRole, number> = {
  viewer: 1,
  operator: 2,
  approver: 3,
  admin: 4,
};

const DEFAULT_ACL: PyreelAclFile = {
  version: 1,
  defaultRole: "viewer",
  grants: [],
};

function normalizeRole(value: unknown): PyreelRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "viewer" ||
    normalized === "operator" ||
    normalized === "approver" ||
    normalized === "admin"
  ) {
    return normalized;
  }
  return undefined;
}

function resolveAclPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "pyreel", "workspace", "acl.json");
}

async function loadAcl(workspaceRoot: string): Promise<PyreelAclFile> {
  const aclPath = resolveAclPath(workspaceRoot);
  try {
    const raw = await fs.readFile(aclPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PyreelAclFile>;
    const defaultRole = normalizeRole(parsed.defaultRole) ?? DEFAULT_ACL.defaultRole;
    const grants = Array.isArray(parsed.grants)
      ? parsed.grants
          .map((entry) => {
            const subject = typeof entry?.subject === "string" ? entry.subject.trim() : "";
            const role = normalizeRole(entry?.role);
            if (!subject || !role) {
              return null;
            }
            return { subject, role } satisfies PyreelAclGrant;
          })
          .filter((entry): entry is PyreelAclGrant => Boolean(entry))
      : [];
    return { version: 1, defaultRole, grants };
  } catch {
    await fs.mkdir(path.dirname(aclPath), { recursive: true });
    await fs.writeFile(aclPath, `${JSON.stringify(DEFAULT_ACL, null, 2)}\n`, "utf8");
    return DEFAULT_ACL;
  }
}

function resolveRole(params: {
  acl: PyreelAclFile;
  channel: string;
  channelId?: string;
  senderId?: string;
}): PyreelRole {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return params.acl.defaultRole ?? "viewer";
  }
  const candidates = [
    params.channelId ? `${params.channel}:${params.channelId}:${senderId}` : undefined,
    `${params.channel}:${senderId}`,
    senderId,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const match = params.acl.grants?.find((grant) => grant.subject === candidate);
    if (match) {
      return match.role;
    }
  }
  return params.acl.defaultRole ?? "viewer";
}

function resolveRequiredRole(rawBodyNormalized: string): PyreelRole | null {
  const trimmed = rawBodyNormalized.trim();
  if (!trimmed.toLowerCase().startsWith("/pyreel")) {
    return null;
  }
  const rest = trimmed.slice("/pyreel".length).trim().toLowerCase();
  if (!rest || rest.startsWith("status") || rest.startsWith("report")) {
    return "viewer";
  }
  if (rest.startsWith("draft") || rest.startsWith("generate")) {
    return "operator";
  }
  if (rest.startsWith("apply")) {
    return "approver";
  }
  if (
    rest.startsWith("proactive") ||
    rest.startsWith("auto-apply") ||
    rest.startsWith("autoapply")
  ) {
    return "admin";
  }
  return "operator";
}

export async function authorizePyreelCommand(params: {
  workspaceRoot: string;
  channel: string;
  channelId?: string;
  senderId?: string;
  rawBodyNormalized: string;
}): Promise<{ allowed: boolean; requiredRole?: PyreelRole; actualRole?: PyreelRole } | null> {
  const requiredRole = resolveRequiredRole(params.rawBodyNormalized);
  if (!requiredRole) {
    return null;
  }
  const acl = await loadAcl(params.workspaceRoot);
  const actualRole = resolveRole({
    acl,
    channel: params.channel,
    channelId: params.channelId,
    senderId: params.senderId,
  });
  return {
    allowed: ROLE_ORDER[actualRole] >= ROLE_ORDER[requiredRole],
    requiredRole,
    actualRole,
  };
}
