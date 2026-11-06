/**
 * `spec.security`: what an extension declares it needs, and why.
 *
 * The declaration is the "Declare" step of the OCT security model
 * (docs/security-model.md). It drives CI checks and the text shown in the install
 * review, but it is never trusted for enforcement: the storefront and CI derive the
 * real profile from the manifests (security-profile.ts).
 *
 * Compatibility rules:
 * - The block is optional; a missing block means "Not declared", never an error.
 * - Older storefronts ignore it (their parsers keep only known fields).
 * - Unknown keys are preserved in `extra` so a newer schema survives this
 *   storefront rewriting its cache ConfigMaps.
 *
 * Pure module: no console SDK imports.
 */
import { SECURITY_LEVELS, SecurityLevel } from './security-profile';

export const SECURITY_SCHEMA = 1;

export type BackendAuth = 'none' | 'ssar' | 'tokenreview';
export type AuthMode = 'off' | 'audit' | 'enforce';
export type IngressKind = 'console-only' | 'route' | 'node';

export type DeclaredRule = {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
  why?: string;
};

export type SecuritySpec = {
  schema: number;
  level?: SecurityLevel;
  summary?: string;
  /** Where to report vulnerabilities, e.g. a GitHub security advisory URL. */
  contact?: string;
  backend?: {
    /** Service names behind the ConsolePlugin proxy. */
    services: string[];
    auth?: BackendAuth;
    /** AUTH_MODE the backend ships with. */
    authModeDefault?: AuthMode;
    /** Paths served without authentication (e.g. an image cache for Ironic). */
    publicPaths: string[];
  };
  network?: {
    ingress?: IngressKind;
    routes: Array<{ name: string; paths: string[]; why?: string }>;
    networkPolicy?: boolean;
    egress: Array<{ host: string; why?: string }>;
  };
  rbac?: { rules: DeclaredRule[] };
  privileged?: {
    scc: string[];
    hostAccess: string[];
    /** Objects the plugin creates at runtime (not in the bundle), e.g. an SCC. */
    runtimeCreates: Array<{ kind: string; name: string; cleanup?: string; why?: string }>;
  };
  secrets?: { access?: 'none' | 'namespaced' | 'cluster'; why?: string };
  supplyChain?: { digestPinned?: boolean; signed?: 'none' | 'cosign' };
  /** Unknown keys from a newer schema, kept so they round-trip. */
  extra?: Record<string, unknown>;
};

const KNOWN_KEYS = new Set(['schema', 'level', 'summary', 'contact', 'backend', 'network', 'rbac', 'privileged', 'secrets', 'supplyChain']);
const EXTRA_MAX_BYTES = 16 * 1024;

type Raw = Record<string, unknown>;

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean) : [];
}
/** Like strList, but keeps "" (the core API group in RBAC rules). */
function groupList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => x != null).map((x) => String(x).trim()) : [];
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const s = str(v);
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

/**
 * Parse a `security` block. Returns undefined when absent or not an object.
 * Never throws: invalid parts are dropped and reported in `warnings`.
 */
export function parseSecurity(v: unknown, warnings: string[] = []): SecuritySpec | undefined {
  if (v == null) return undefined;
  if (!isObj(v)) {
    warnings.push('spec.security must be a mapping; ignored.');
    return undefined;
  }
  const schemaNum = Number(v.schema ?? SECURITY_SCHEMA);
  const spec: SecuritySpec = { schema: Number.isFinite(schemaNum) && schemaNum > 0 ? schemaNum : SECURITY_SCHEMA };
  if (spec.schema > SECURITY_SCHEMA) warnings.push(`spec.security schema ${spec.schema} is newer than this storefront understands (${SECURITY_SCHEMA}).`);

  const level = oneOf(v.level, SECURITY_LEVELS);
  if (v.level != null && !level) warnings.push(`spec.security.level "${String(v.level)}" is not one of ${SECURITY_LEVELS.join(', ')}.`);
  if (level) spec.level = level;
  if (str(v.summary)) spec.summary = str(v.summary);
  if (str(v.contact)) spec.contact = str(v.contact);

  if (isObj(v.backend)) {
    const b = v.backend;
    spec.backend = {
      services: strList(b.services),
      publicPaths: strList(b.publicPaths),
    };
    const auth = oneOf(b.auth, ['none', 'ssar', 'tokenreview'] as const);
    if (auth) spec.backend.auth = auth;
    const mode = oneOf(b.authModeDefault, ['off', 'audit', 'enforce'] as const);
    if (mode) spec.backend.authModeDefault = mode;
  }
  if (isObj(v.network)) {
    const n = v.network;
    spec.network = {
      routes: (Array.isArray(n.routes) ? n.routes : []).filter(isObj).map((r) => ({ name: str(r.name) || '', paths: strList(r.paths), ...(str(r.why) ? { why: str(r.why) } : {}) })).filter((r) => r.name),
      egress: (Array.isArray(n.egress) ? n.egress : []).filter(isObj).map((e) => ({ host: str(e.host) || '', ...(str(e.why) ? { why: str(e.why) } : {}) })).filter((e) => e.host),
    };
    const ingress = oneOf(n.ingress, ['console-only', 'route', 'node'] as const);
    if (ingress) spec.network.ingress = ingress;
    if (typeof n.networkPolicy === 'boolean') spec.network.networkPolicy = n.networkPolicy;
  }
  if (isObj(v.rbac)) {
    spec.rbac = {
      rules: (Array.isArray(v.rbac.rules) ? v.rbac.rules : []).filter(isObj).map((r) => {
        const rule: DeclaredRule = { apiGroups: groupList(r.apiGroups), resources: strList(r.resources), verbs: strList(r.verbs) };
        if (strList(r.resourceNames).length) rule.resourceNames = strList(r.resourceNames);
        if (str(r.why)) rule.why = str(r.why);
        return rule;
      }),
    };
  }
  if (isObj(v.privileged)) {
    const p = v.privileged;
    spec.privileged = {
      scc: strList(p.scc),
      hostAccess: strList(p.hostAccess),
      runtimeCreates: (Array.isArray(p.runtimeCreates) ? p.runtimeCreates : [])
        .filter(isObj)
        .map((o) => ({ kind: str(o.kind) || '', name: str(o.name) || '', ...(str(o.cleanup) ? { cleanup: str(o.cleanup) } : {}), ...(str(o.why) ? { why: str(o.why) } : {}) }))
        .filter((o) => o.kind && o.name),
    };
  }
  if (isObj(v.secrets)) {
    spec.secrets = {};
    const access = oneOf(v.secrets.access, ['none', 'namespaced', 'cluster'] as const);
    if (access) spec.secrets.access = access;
    if (str(v.secrets.why)) spec.secrets.why = str(v.secrets.why);
  }
  if (isObj(v.supplyChain)) {
    spec.supplyChain = {};
    if (typeof v.supplyChain.digestPinned === 'boolean') spec.supplyChain.digestPinned = v.supplyChain.digestPinned;
    const signed = oneOf(v.supplyChain.signed, ['none', 'cosign'] as const);
    if (signed) spec.supplyChain.signed = signed;
  }

  const extra: Raw = {};
  for (const [k, val] of Object.entries(v)) if (!KNOWN_KEYS.has(k)) extra[k] = val;
  if (Object.keys(extra).length) {
    try {
      const json = JSON.stringify(extra);
      if (json.length <= EXTRA_MAX_BYTES) spec.extra = JSON.parse(json) as Raw;
      else warnings.push('spec.security has unknown keys larger than 16 KB; they were dropped.');
    } catch {
      warnings.push('spec.security has unknown keys that are not plain data; they were dropped.');
    }
  }
  return spec;
}

/** Plain JSON form for serialization; unknown keys are merged back in. */
export function securityToJson(spec: SecuritySpec): Raw {
  const { extra, ...known } = spec;
  return { ...(extra || {}), ...JSON.parse(JSON.stringify(known)) };
}
