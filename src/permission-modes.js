export const PERMISSION_MODES = ["safe", "normal", "danger"];

export function normalizePermissionMode(value = "", fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "default") return "normal";
  if (PERMISSION_MODES.includes(normalized)) return normalized;
  return PERMISSION_MODES.includes(fallback) ? fallback : "normal";
}

export function permissionModeLabel(mode = "normal") {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "safe") return "Safe";
  if (normalized === "danger") return "Danger";
  return "Normal";
}

export function permissionModeDescription(mode = "normal") {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "safe") {
    return "Ask before workspace writes and setup; keep execution read-focused and non-destructive.";
  }
  if (normalized === "danger") {
    return "Trusted host access with destructive shell, host installs, password typing, and outside-workspace file paths enabled.";
  }
  return "Allow current-project writes and Docker setup; ask before outside-project or host-system changes.";
}

export function permissionModeDefaults(mode = "normal") {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "safe") {
    return {
      permissionMode: "safe",
      sandboxMode: "docker-readonly",
      packageInstallPolicy: "prompt",
      useDockerSandbox: true,
      allowShellTool: true,
      allowFileTools: true,
      allowDestructive: false,
      allowPasswords: false,
      workspaceWritePolicy: "prompt",
      allowOutsideWorkspaceFileTools: false,
    };
  }
  if (normalized === "danger") {
    return {
      permissionMode: "danger",
      sandboxMode: "host",
      packageInstallPolicy: "allow",
      useDockerSandbox: false,
      allowShellTool: true,
      allowFileTools: true,
      allowDestructive: true,
      allowPasswords: true,
      workspaceWritePolicy: "allow",
      allowOutsideWorkspaceFileTools: true,
    };
  }
  return {
    permissionMode: "normal",
    sandboxMode: "docker-workspace",
    packageInstallPolicy: "allow",
    useDockerSandbox: true,
    allowShellTool: true,
    allowFileTools: true,
    allowDestructive: false,
    allowPasswords: false,
    workspaceWritePolicy: "allow",
    allowOutsideWorkspaceFileTools: false,
  };
}

export function applyPermissionMode(target = {}, mode = "normal", { override = true } = {}) {
  const defaults = permissionModeDefaults(mode);
  target.permissionMode = defaults.permissionMode;
  for (const [key, value] of Object.entries(defaults)) {
    if (key === "permissionMode") continue;
    if (override || target[key] === undefined || target[key] === "") {
      target[key] = value;
    }
  }
  return target;
}

export function permissionModeForApprovalCategory(category = "") {
  const normalized = String(category || "").trim().toLowerCase();
  if (["workspace-write", "package-install", "env-setup", "network-fetch", "git-remote"].includes(normalized)) {
    return "normal";
  }
  return "danger";
}

