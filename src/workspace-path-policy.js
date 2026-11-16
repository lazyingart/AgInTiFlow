import path from "node:path";
import { types } from "node:util";

export const WORKSPACE_SCOPE_FIELDS = Object.freeze([
  "workspacePathScopeRoots",
  "workspaceWritePathScopeRoots",
]);

export class WorkspaceScopePolicyError extends Error {
  constructor(field) {
    super("Workspace path scopes must be bounded, explicit directory lists inside the configured workspace.");
    this.code = "WORKSPACE_SCOPE_POLICY_INVALID";
    this.field = field;
  }
}

const invalid = field => { throw new WorkspaceScopePolicyError(field); };
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Trusted host configuration, normalized before it becomes durable authority.
// This is lexical policy, not filesystem identity, openat or an OS sandbox.
// Missing fresh configuration defaults to []. Invalid or outside roots never
// collapse to that unrestricted policy; stored policy must be explicit.
export function normalizeWorkspaceScopeRoots(value, commandCwd, field = "workspacePathScopeRoots", { stored = false } = {}) {
  if (value === undefined && !stored) return [];
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(field);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 32 || keys.length !== length + 1) invalid(field);
  const root = path.resolve(commandCwd || process.cwd()), values = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid(field);
    const raw = descriptor.value;
    if (typeof raw !== "string" || !raw || raw.trim() !== raw || !raw.isWellFormed() ||
        Buffer.byteLength(raw) > 4096 || /[\x00-\x1f\x7f]/u.test(raw) ||
        (process.platform !== "win32" && /[\\]|^[A-Za-z]:/u.test(raw)) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) invalid(field);
    const input = raw === "/workspace" ? "." : raw.startsWith("/workspace/") ? raw.slice(11) : raw;
    const absolute = path.resolve(root, input);
    if (!inside(root, absolute)) invalid(field);
    const canonical = path.relative(root, absolute).split(path.sep).join("/") || ".";
    if ((stored && raw !== canonical) || values.includes(canonical)) invalid(field);
    values.push(canonical);
  }
  const sorted = values.toSorted();
  if (stored && sorted.some((item, index) => item !== values[index])) invalid(field);
  return sorted;
}

// Each nonempty group restricts the others; a read scope is never an
// alternative grant for a write outside the explicit write/task scope.
export function workspacePathScopePlan(config, root, { writeAccess = false } = {}) {
  const names = ["workspacePathScopeRoots"];
  if (writeAccess) names.push("workspaceWritePathScopeRoots");
  const values = names.map(field => normalizeWorkspaceScopeRoots(config[field], root, field));
  if (writeAccess && config.scopedArtifactTask === true) {
    values.push(normalizeWorkspaceScopeRoots([config.scopedArtifactRoot], root, "scopedArtifactRoot"));
  }
  const groups = values.filter(items => items.length).map(items => items.map(value => path.resolve(root, value)));
  let roots = groups[0] || [];
  for (const group of groups.slice(1)) {
    const intersection = [];
    for (const a of roots) for (const b of group) {
      const value = inside(a, b) ? b : inside(b, a) ? a : null;
      if (value !== null && !intersection.includes(value)) intersection.push(value);
    }
    roots = intersection;
  }
  return { roots, restricted: groups.length > 0 };
}
