/**
 * Cluster-admin policy: the "Decide" step of the OCT security model (docs/security-model.md).
 *
 * The policy lives in ConfigMap `community-tools-policy` (namespace oct-storefront, key
 * `policy.yaml`). It is never created by install, so a cluster without it gets
 * DEFAULT_POLICY, which keeps today's behaviour except that elevated installs show
 * a review screen first.
 *
 * Storefront policy is advisory: the storefront applies manifests with the user's own
 * token, so it can explain, ask for review, or refuse to click Install, but it cannot
 * stop someone applying the same YAML by hand. Hard limits come from RBAC and the
 * opt-in ValidatingAdmissionPolicy pack (deploy/policy/vap/).
 *
 * Pure module: no console SDK imports (shared with CI and unit tests).
 */
import { load } from 'js-yaml';
import { levelRank, SECURITY_LEVELS, SecurityLevel, SecurityProfile } from './security-profile';
import type { SecuritySpec } from './security-spec';

export const POLICY_CONFIGMAP = 'community-tools-policy';
export const POLICY_KEY = 'policy.yaml';

export type PolicyMode = 'off' | 'warn' | 'enforce';
export type ReviewMode = 'never' | 'elevated' | 'always';
export type Gate = 'allow' | 'warn' | 'review' | 'block';
export type TelemetryMode = 'full' | 'ratings-only' | 'off';
export type BackendAuthMode = 'audit' | 'enforce';
export type DigestRule = 'none' | 'community' | 'all';

/** Per-tool exceptions. Only these keys can be overridden per tool. */
export type ToolOverride = {
  maxLevel?: SecurityLevel;
  allowRoutes?: boolean;
  requireNetworkPolicy?: boolean;
  allowedRegistries?: string[];
  requireDigest?: DigestRule;
  review?: ReviewMode;
};

export type Policy = {
  /** off: never block or warn; warn: show reasons, never block (default); enforce: block. */
  mode: PolicyMode;
  /** When to show the install review screen. Default: elevated. */
  review: ReviewMode;
  /** Highest derived level allowed. Unset: no limit. */
  maxLevel?: SecurityLevel;
  /** Tools pasted in by users (Add external). */
  external: Exclude<Gate, 'warn'>;
  externalMaxLevel?: SecurityLevel;
  /** full: tiles, versions and install manifests; metadata-only: tiles only; off: no sync. */
  publicCatalog: 'full' | 'metadata-only' | 'off';
  /** Updates that add RBAC permissions. */
  rbacWidening: Gate;
  allowRoutes: boolean;
  requireNetworkPolicy: boolean;
  /** Registries images may come from (prefix match on host, e.g. quay.io/cjanisze). Empty: any. */
  allowedRegistries: string[];
  requireDigest: DigestRule;
  /** Hosts deployURL may point at. Empty: any. */
  allowedDeployHosts: string[];
  telemetry: TelemetryMode;
  /** Runtime auth mode override per extension backend, read by backend-security-kit. */
  backends: Record<string, { authMode: BackendAuthMode }>;
  perTool: Record<string, ToolOverride>;
};

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  mode: 'warn',
  review: 'elevated',
  external: 'allow',
  publicCatalog: 'full',
  rbacWidening: 'warn',
  allowRoutes: true,
  requireNetworkPolicy: false,
  allowedRegistries: [],
  requireDigest: 'none',
  allowedDeployHosts: [],
  telemetry: 'full',
  backends: {},
  perTool: {},
}) as Policy;

type Raw = Record<string, unknown>;

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean) : [];
}
function pickEnum<T extends string>(raw: Raw, key: string, allowed: readonly T[], warnings: string[], prefix = ''): T | undefined {
  if (raw[key] == null) return undefined;
  const v = String(raw[key]).trim();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  warnings.push(`${prefix}${key}: "${v}" is not one of ${allowed.join(', ')}; using the default.`);
  return undefined;
}
function pickBool(raw: Raw, key: string, warnings: string[], prefix = ''): boolean | undefined {
  if (raw[key] == null) return undefined;
  if (typeof raw[key] === 'boolean') return raw[key] as boolean;
  warnings.push(`${prefix}${key} must be true or false; using the default.`);
  return undefined;
}

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function parseOverride(raw: Raw, warnings: string[], prefix: string): ToolOverride {
  const o: ToolOverride = {};
  const maxLevel = pickEnum(raw, 'maxLevel', SECURITY_LEVELS, warnings, prefix);
  if (maxLevel) o.maxLevel = maxLevel;
  const allowRoutes = pickBool(raw, 'allowRoutes', warnings, prefix);
  if (allowRoutes != null) o.allowRoutes = allowRoutes;
  const requireNetworkPolicy = pickBool(raw, 'requireNetworkPolicy', warnings, prefix);
  if (requireNetworkPolicy != null) o.requireNetworkPolicy = requireNetworkPolicy;
  if (Array.isArray(raw.allowedRegistries)) o.allowedRegistries = strList(raw.allowedRegistries);
  const requireDigest = pickEnum(raw, 'requireDigest', ['none', 'community', 'all'] as const, warnings, prefix);
  if (requireDigest) o.requireDigest = requireDigest;
  const review = pickEnum(raw, 'review', ['never', 'elevated', 'always'] as const, warnings, prefix);
  if (review) o.review = review;
  return o;
}

/**
 * Parse policy.yaml. Never throws: an unreadable document or invalid value falls
 * back to the default for that setting and adds a warning to show in the UI.
 */
export function parsePolicy(text: string | undefined, warnings: string[] = []): Policy {
  const policy: Policy = { ...DEFAULT_POLICY, allowedRegistries: [], allowedDeployHosts: [], backends: {}, perTool: {} };
  if (!text || !text.trim()) return policy;
  let raw: unknown;
  try {
    raw = load(text);
  } catch (e) {
    warnings.push(`policy.yaml is not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); using the defaults.`);
    return policy;
  }
  if (raw == null) return policy;
  if (!isObj(raw)) {
    warnings.push('policy.yaml must be a mapping; using the defaults.');
    return policy;
  }

  policy.mode = pickEnum(raw, 'mode', ['off', 'warn', 'enforce'] as const, warnings) || policy.mode;
  policy.review = pickEnum(raw, 'review', ['never', 'elevated', 'always'] as const, warnings) || policy.review;
  policy.maxLevel = pickEnum(raw, 'maxLevel', SECURITY_LEVELS, warnings);
  policy.external = pickEnum(raw, 'external', ['allow', 'review', 'block'] as const, warnings) || policy.external;
  policy.externalMaxLevel = pickEnum(raw, 'externalMaxLevel', SECURITY_LEVELS, warnings);
  policy.publicCatalog = pickEnum(raw, 'publicCatalog', ['full', 'metadata-only', 'off'] as const, warnings) || policy.publicCatalog;
  policy.rbacWidening = pickEnum(raw, 'rbacWidening', ['allow', 'warn', 'review', 'block'] as const, warnings) || policy.rbacWidening;
  policy.allowRoutes = pickBool(raw, 'allowRoutes', warnings) ?? policy.allowRoutes;
  policy.requireNetworkPolicy = pickBool(raw, 'requireNetworkPolicy', warnings) ?? policy.requireNetworkPolicy;
  policy.allowedRegistries = strList(raw.allowedRegistries);
  policy.requireDigest = pickEnum(raw, 'requireDigest', ['none', 'community', 'all'] as const, warnings) || policy.requireDigest;
  policy.allowedDeployHosts = strList(raw.allowedDeployHosts).map((h) => h.toLowerCase());
  policy.telemetry = pickEnum(raw, 'telemetry', ['full', 'ratings-only', 'off'] as const, warnings) || policy.telemetry;
  if (!policy.maxLevel) delete policy.maxLevel;
  if (!policy.externalMaxLevel) delete policy.externalMaxLevel;

  if (isObj(raw.backends)) {
    for (const [name, v] of Object.entries(raw.backends)) {
      if (!DNS1123.test(name) || !isObj(v)) {
        warnings.push(`backends.${name}: expected an extension name with { authMode: audit | enforce }; ignored.`);
        continue;
      }
      // `off` is deliberately not accepted: audit is the floor for migrated backends.
      const authMode = pickEnum(v, 'authMode', ['audit', 'enforce'] as const, warnings, `backends.${name}.`);
      if (authMode) policy.backends[name] = { authMode };
    }
  }
  if (isObj(raw.perTool)) {
    for (const [name, v] of Object.entries(raw.perTool)) {
      if (!DNS1123.test(name) || !isObj(v)) {
        warnings.push(`perTool.${name}: expected an extension name with a mapping of overrides; ignored.`);
        continue;
      }
      policy.perTool[name] = parseOverride(v, warnings, `perTool.${name}.`);
    }
  }
  return policy;
}

/** The policy with per-tool overrides applied. */
export function effectivePolicy(policy: Policy, toolId: string): Policy {
  const o = policy.perTool[toolId];
  return o ? { ...policy, ...o } : policy;
}

export type InstallContext = {
  toolId: string;
  /** community: from the bundled or public catalog; external: pasted by a user. */
  source: 'community' | 'external';
  /** In the public catalog only, not in this storefront's bundled catalog. */
  publicOnly?: boolean;
  action: 'add' | 'update';
  profile: SecurityProfile;
  declared?: SecuritySpec;
  /** deployURL the YAML was fetched from, if any. */
  deployURL?: string;
  /** Permissions added by an update (from rbacDiff). */
  rbacAdded?: { role: string; added: string[] }[];
};

export type Reason = {
  /** Stable id, e.g. `max-level`, `route`, `registry`. */
  id: string;
  /** What this reason does to the install. */
  gate: Gate;
  message: string;
};

export type Decision = {
  /** The strictest gate after applying the mode. */
  outcome: Gate;
  /** Show the install review screen before applying. */
  review: boolean;
  reasons: Reason[];
};

const GATE_RANK: Record<Gate, number> = { allow: 0, warn: 1, review: 2, block: 3 };

function hostOf(url: string): string {
  const m = url.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function registryAllowed(ref: string, allowed: string[]): boolean {
  return allowed.some((a) => ref === a || ref.startsWith(a.endsWith('/') ? a : `${a}/`) || ref.startsWith(`${a}:`) || ref.startsWith(`${a}@`));
}

/**
 * Evaluate the policy against a derived profile. The declaration is only used to
 * explain (and to flag "exceeds declaration"); it never relaxes a check.
 */
export function evaluate(basePolicy: Policy, ctx: InstallContext): Decision {
  const policy = effectivePolicy(basePolicy, ctx.toolId);
  const reasons: Reason[] = [];
  const add = (id: string, gate: Gate, message: string) => {
    if (gate !== 'allow') reasons.push({ id, gate, message });
  };
  const { profile } = ctx;
  const level = profile.level;
  const external = ctx.source === 'external';

  if (policy.maxLevel && levelRank(level) > levelRank(policy.maxLevel)) {
    add('max-level', 'block', `Needs ${level} access; this cluster allows at most ${policy.maxLevel}.`);
  }
  if (external) {
    add('external', policy.external, 'This tool was added by a user and is not in the community catalog.');
    if (policy.externalMaxLevel && levelRank(level) > levelRank(policy.externalMaxLevel)) {
      add('external-max-level', 'block', `Needs ${level} access; external tools may use at most ${policy.externalMaxLevel}.`);
    }
  }
  if (!policy.allowRoutes && profile.routes.length) {
    add('route', 'block', `Creates Route(s) ${profile.routes.map((r) => r.name).join(', ')}, which expose a service outside the cluster.`);
  }
  const hasBackend = profile.proxies.length > 0 || profile.exposedServices.length > 0;
  if (policy.requireNetworkPolicy && hasBackend && !profile.networkPolicies.length) {
    add('network-policy', 'block', 'Runs a backend service without a NetworkPolicy.');
  }
  if (policy.allowedRegistries.length) {
    const bad = profile.images.filter((i) => !registryAllowed(i.ref, policy.allowedRegistries));
    if (bad.length) add('registry', 'block', `Images from registries not on the allowed list: ${bad.map((i) => i.ref).join(', ')}.`);
  }
  if (policy.requireDigest === 'all' || (policy.requireDigest === 'community' && !external)) {
    const unpinned = profile.images.filter((i) => !i.digest);
    if (unpinned.length) add('digest', 'block', `Images not pinned by digest: ${unpinned.map((i) => i.ref).join(', ')}.`);
  }
  if (policy.allowedDeployHosts.length && ctx.deployURL) {
    const host = hostOf(ctx.deployURL);
    if (!policy.allowedDeployHosts.includes(host)) add('deploy-host', 'block', `Install manifest comes from ${host || ctx.deployURL}, which is not an allowed host.`);
  }
  const widened = (ctx.rbacAdded || []).filter((r) => r.added.length);
  if (ctx.action === 'update' && widened.length) {
    add('rbac-widening', policy.rbacWidening, `This update adds permissions: ${widened.map((r) => `${r.role} (${r.added.join('; ')})`).join(', ')}.`);
  }
  if (ctx.declared?.level && levelRank(level) > levelRank(ctx.declared.level)) {
    add('exceeds-declaration', 'warn', `The manifests need ${level} access, but the tool declares ${ctx.declared.level}.`);
  }

  // Mode: off ignores every reason; warn turns blocks into warnings shown on review.
  let effective = reasons;
  if (policy.mode === 'off') effective = [];
  else if (policy.mode === 'warn') effective = reasons.map((r) => (r.gate === 'block' ? { ...r, gate: 'review' as Gate, message: `${r.message} (policy would block this in enforce mode)` } : r));

  const outcome = effective.reduce<Gate>((acc, r) => (GATE_RANK[r.gate] > GATE_RANK[acc] ? r.gate : acc), 'allow');

  let review = outcome === 'review' || outcome === 'block';
  if (policy.review === 'always') review = true;
  else if (policy.review === 'elevated') {
    review =
      review ||
      level !== 'plugin' ||
      profile.routes.length > 0 ||
      external ||
      !!ctx.publicOnly ||
      widened.length > 0;
  }
  return { outcome, review, reasons: effective };
}

/** Telemetry: may a download be counted / a rating be sent? */
export function telemetryAllows(policy: Policy, kind: 'download' | 'rating'): boolean {
  if (policy.telemetry === 'off') return false;
  if (policy.telemetry === 'ratings-only') return kind === 'rating';
  return true;
}
