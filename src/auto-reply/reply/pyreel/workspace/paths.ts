import path from "node:path";

const PYREEL_WORKSPACE_SEGMENTS = ["pyreel", "workspace"] as const;

function rejectUnsafePathInput(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }

  const normalized = value.replace(/\\/g, "/");
  if (path.isAbsolute(value) || normalized.startsWith("/")) {
    throw new Error(`${label} must be relative`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} cannot contain '..'`);
  }
}

function assertWithinWorkspaceRoot(workspaceRoot: string, candidatePath: string): void {
  const absoluteWorkspace = path.resolve(workspaceRoot, ...PYREEL_WORKSPACE_SEGMENTS);
  const relative = path.relative(absoluteWorkspace, candidatePath);
  if (relative === "" || relative === ".") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes pyreel/workspace root");
  }
}

export function resolvePyreelWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot || workspaceRoot.trim().length === 0) {
    throw new Error("workspaceRoot must be non-empty");
  }
  return path.resolve(workspaceRoot, ...PYREEL_WORKSPACE_SEGMENTS);
}

export function resolvePyreelWorkspacePath(workspaceRoot: string, relativePath: string): string {
  rejectUnsafePathInput(relativePath, "relativePath");
  const workspacePath = resolvePyreelWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(workspacePath, relativePath);
  assertWithinWorkspaceRoot(workspaceRoot, resolved);
  return resolved;
}

export function resolvePyreelWorkspaceFilePath(workspaceRoot: string, fileName: string): string {
  rejectUnsafePathInput(fileName, "fileName");
  if (fileName.includes("/")) {
    throw new Error("fileName must not include directory separators");
  }
  return resolvePyreelWorkspacePath(workspaceRoot, fileName);
}

export function resolvePyreelWorkspaceSubdirPath(workspaceRoot: string, dirName: string): string {
  rejectUnsafePathInput(dirName, "dirName");
  if (dirName.includes("/")) {
    throw new Error("dirName must not include directory separators");
  }
  return resolvePyreelWorkspacePath(workspaceRoot, dirName);
}

export function resolvePyreelWorkspaceRelativePath(
  workspaceRoot: string,
  targetPath: string,
): string {
  const root = resolvePyreelWorkspaceRoot(workspaceRoot);
  const relative = path.relative(workspaceRoot, targetPath);
  assertWithinWorkspaceRoot(workspaceRoot, targetPath);
  if (relative === "" || relative === ".") {
    return path.relative(workspaceRoot, root);
  }
  return relative;
}
