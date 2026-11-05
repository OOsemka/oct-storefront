/**
 * Security profile of a deploy bundle: what the manifests that will actually be
 * applied can do (RBAC, SCC/host access, images, network exposure, secrets).
 *
 * This is the "Derive" step of the OCT security model (docs/security-model.md):
 * the storefront and CI both compute the profile from real manifests, so a
 * missing or wrong `spec.security` declaration can never hide what a bundle does.
 *
 * Pure module: no console SDK imports, so CI (scripts/security-check.ts) and unit
 * tests can use it outside the browser.
 */
import { loadAll } from 'js-yaml';

export type SecurityLevel = 'plugin' | 'namespaced' | 'cluster-read' | 'cluster-write' | 'privileged';

/** Lowest to highest. */
export const SECURITY_LEVELS: SecurityLevel[] = ['plugin', 'namespaced', 'cluster-read', 'cluster-write', 'privileged'];

export function levelRank(level: SecurityLevel): number {
  return SECURITY_LEVELS.indexOf(level);
}

export function maxLevel(a: SecurityLevel, b: SecurityLevel): SecurityLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

export type FindingSeverity = 'info' | 'warn' | 'high';

export interface ProfileFinding {
  /** Stable identifier used by the CI baseline, e.g. `rbac-cluster-secrets-read`. */
  id: string;
  severity: FindingSeverity;
  /** Object the finding is about, e.g. `ClusterRole/oct-foo`. */
  object: string;
  message: string;
  /** Raises the derived level to at least this. Omitted for hardening-only findings. */
  level?: SecurityLevel;
}

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

export interface ScopedRule extends RbacRule {
  /** Role or ClusterRole that defines the rule. */
  role: string;
  /** `cluster` when granted cluster-wide (ClusterRoleBinding), else the namespace. */
  scope: string;
}

export interface ImageRef {
  ref: string;
  registry: string;
  digest: boolean;
  workload: string;
}

export interface RouteInfo {
  name: string;
  namespace?: string;
  service?: string;
  path?: string;
  tls: boolean;
}

export interface ProxyInfo {
  plugin: string;
  alias: string;
  service?: string;
  authorization: string;
}

export interface SecurityProfile {
  level: SecurityLevel;
  kinds: Record<string, number>;
  /** Rules that apply cluster-wide. */
  clusterRules: ScopedRule[];
  /** Rules that apply within one namespace. */
  namespacedRules: ScopedRule[];
  scc: string[];
  hostAccess: string[];
  images: ImageRef[];
  routes: RouteInfo[];
  exposedServices: string[];
  secretsInBundle: Array<{ name: string; hasData: boolean }>;
  networkPolicies: string[];
  proxies: ProxyInfo[];
  findings: ProfileFinding[];
}

// Manifests are untyped YAML; narrow at the point of use.
type Obj = Record<string, any>;

const READ_VERBS = new Set(['get', 'list', 'watch']);
const WORKLOAD_RESOURCES = new Set([
  'pods',
  'deployments',
  'statefulsets',
  'daemonsets',
  'replicasets',
  'replicationcontrollers',
  'jobs',
  'cronjobs',
  'deploymentconfigs',
]);
const ESCALATION_VERBS = new Set(['escalate', 'bind', 'impersonate']);
/** Built-in ClusterRoles a bundle may bind without defining them. */
const BUILTIN_ROLE_LEVEL: Record<string, SecurityLevel> = {
  'cluster-admin': 'privileged',
  admin: 'privileged',
  edit: 'privileged',
  view: 'cluster-read',
  'system:auth-delegator': 'cluster-read',
};
const SCC_ROLE_PREFIX = 'system:openshift:scc:';

function asArray<T = string>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function objName(doc: Obj): string {
  return `${doc.kind || 'Unknown'}/${doc.metadata?.name || '(unnamed)'}`;
}

/** Parse multi-document YAML into objects that have a `kind`. Invalid YAML yields []. */
export function parseBundle(yaml: string): Obj[] {
  try {
    return (loadAll(yaml || '') as unknown[]).filter((d): d is Obj => !!d && typeof d === 'object' && !!(d as Obj).kind);
  } catch {
    return [];
  }
}

function normalizeRule(r: Obj): RbacRule {
  const rule: RbacRule = {
    apiGroups: asArray(r.apiGroups),
    resources: asArray(r.resources),
    verbs: asArray(r.verbs),
  };
  if (Array.isArray(r.resourceNames) && r.resourceNames.length) rule.resourceNames = r.resourceNames;
  if (Array.isArray(r.nonResourceURLs) && r.nonResourceURLs.length) rule.nonResourceURLs = r.nonResourceURLs;
  return rule;
}

function isReadOnly(rule: RbacRule): boolean {
  return rule.verbs.length > 0 && rule.verbs.every((v) => READ_VERBS.has(v));
}

/** Findings for a single rule at a scope. `cluster` scope is what makes most of these dangerous. */
function ruleFindings(rule: ScopedRule): ProfileFinding[] {
  const out: ProfileFinding[] = [];
  const obj = `${rule.scope === 'cluster' ? 'ClusterRole' : 'Role'}/${rule.role}`;
  const cluster = rule.scope === 'cluster';
  const has = (list: string[], v: string) => list.includes(v) || list.includes('*');
  const wildcard = rule.verbs.includes('*') || rule.resources.includes('*') || rule.apiGroups.includes('*');

  if (wildcard) {
    out.push({ id: 'rbac-wildcard', severity: 'high', object: obj, level: 'privileged', message: 'RBAC rule uses a wildcard (*).' });
  }
  for (const v of rule.verbs) {
    if (ESCALATION_VERBS.has(v)) {
      out.push({ id: `rbac-${v}`, severity: 'high', object: obj, level: 'privileged', message: `RBAC rule grants "${v}".` });
    }
  }
  if (rule.apiGroups.some((g) => g === 'security.openshift.io' || g === '*') && has(rule.resources, 'securitycontextconstraints') && has(rule.verbs, 'use')) {
    const names = rule.resourceNames?.length ? rule.resourceNames.join(', ') : 'any SCC';
    out.push({ id: 'scc-use', severity: 'high', object: obj, level: 'privileged', message: `Can use SecurityContextConstraints: ${names}.` });
  }
  if (!cluster) return out;

  if (has(rule.resources, 'secrets') && rule.verbs.some((v) => READ_VERBS.has(v) || v === '*') && !rule.resourceNames?.length) {
    out.push({ id: 'rbac-cluster-secrets-read', severity: 'high', object: obj, level: 'privileged', message: 'Can read Secrets in every namespace.' });
  }
  if (rule.resources.includes('pods/exec') && has(rule.verbs, 'create')) {
    out.push({ id: 'rbac-cluster-pods-exec', severity: 'high', object: obj, level: 'privileged', message: 'Can exec into pods in every namespace.' });
  }
  if (rule.resources.some((r) => WORKLOAD_RESOURCES.has(r)) && has(rule.verbs, 'create')) {
    out.push({
      id: 'rbac-cluster-workload-create',
      severity: 'high',
      object: obj,
      level: 'privileged',
      message: 'Can create pods or workloads in every namespace (can run as any ServiceAccount).',
    });
  }
  if (rule.resources.some((r) => r === 'clusterroles' || r === 'clusterrolebindings' || r === 'roles' || r === 'rolebindings') && rule.verbs.some((v) => !READ_VERBS.has(v))) {
    out.push({ id: 'rbac-cluster-rbac-write', severity: 'high', object: obj, level: 'privileged', message: 'Can create or change RBAC.' });
  }
  if (has(rule.resources, 'nodes') && rule.verbs.some((v) => !READ_VERBS.has(v))) {
    out.push({ id: 'rbac-cluster-nodes-write', severity: 'high', object: obj, level: 'privileged', message: 'Can modify Nodes.' });
  }
  if (has(rule.resources, 'namespaces') && (has(rule.verbs, 'delete') || has(rule.verbs, 'deletecollection'))) {
    out.push({ id: 'rbac-cluster-namespaces-delete', severity: 'warn', object: obj, level: 'cluster-write', message: 'Can delete Namespaces.' });
  }
  return out;
}

interface PodSpecHolder {
  workload: string;
  spec: Obj;
}

function podSpecs(doc: Obj): PodSpecHolder[] {
  const workload = objName(doc);
  switch (doc.kind) {
    case 'Pod':
      return doc.spec ? [{ workload, spec: doc.spec }] : [];
    case 'CronJob':
      return doc.spec?.jobTemplate?.spec?.template?.spec ? [{ workload, spec: doc.spec.jobTemplate.spec.template.spec }] : [];
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
      return doc.spec?.template?.spec ? [{ workload, spec: doc.spec.template.spec }] : [];
    default:
      return [];
  }
}

/** `quay.io/org/x:tag` -> `quay.io`; `nginx:1` -> `docker.io`. */
export function imageRegistry(ref: string): string {
  const first = ref.split('/')[0];
  if (ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) return first;
  return 'docker.io';
}

function imageFindings(img: ImageRef): ProfileFinding[] {
  const out: ProfileFinding[] = [];
  const base = img.ref.split('@')[0];
  const hasTag = base.lastIndexOf(':') > base.lastIndexOf('/');
  if (!img.digest && (!hasTag || base.endsWith(':latest'))) {
    out.push({ id: 'image-mutable-tag', severity: 'warn', object: img.workload, message: `Image ${img.ref} uses no tag or :latest.` });
  }
  return out;
}

function workloadFindings(holder: PodSpecHolder, images: ImageRef[], hostAccess: string[]): ProfileFinding[] {
  const out: ProfileFinding[] = [];
  const { spec, workload } = holder;
  for (const key of ['hostNetwork', 'hostPID', 'hostIPC'] as const) {
    if (spec[key] === true) {
      hostAccess.push(`${key} (${workload})`);
      out.push({ id: `host-${key}`, severity: 'high', object: workload, level: 'privileged', message: `Pod uses ${key}.` });
    }
  }
  for (const v of asArray<Obj>(spec.volumes)) {
    if (v.hostPath) {
      hostAccess.push(`hostPath ${v.hostPath.path || ''} (${workload})`);
      out.push({ id: 'host-path', severity: 'high', object: workload, level: 'privileged', message: `Pod mounts hostPath ${v.hostPath.path || ''}.` });
    }
  }
  const containers = [...asArray<Obj>(spec.initContainers), ...asArray<Obj>(spec.containers)];
  let hardeningGaps = 0;
  for (const c of containers) {
    if (typeof c.image === 'string' && c.image) {
      const img: ImageRef = { ref: c.image, registry: imageRegistry(c.image), digest: c.image.includes('@sha256:'), workload };
      images.push(img);
      out.push(...imageFindings(img));
    }
    const sc: Obj = c.securityContext || {};
    if (sc.privileged === true) {
      hostAccess.push(`privileged container ${c.name || ''} (${workload})`);
      out.push({ id: 'container-privileged', severity: 'high', object: workload, level: 'privileged', message: `Container ${c.name || ''} is privileged.` });
    }
    for (const cap of asArray(sc.capabilities?.add)) {
      hostAccess.push(`capability ${cap} (${workload})`);
      out.push({ id: `capability-${String(cap).toLowerCase()}`, severity: 'high', object: workload, level: 'privileged', message: `Container ${c.name || ''} adds capability ${cap}.` });
    }
    if (sc.allowPrivilegeEscalation !== false || sc.readOnlyRootFilesystem !== true || sc.runAsNonRoot === false) hardeningGaps++;
  }
  if (hardeningGaps > 0) {
    out.push({
      id: 'workload-hardening',
      severity: 'info',
      object: workload,
      message: 'Containers should set allowPrivilegeEscalation: false and readOnlyRootFilesystem: true, and run as non-root.',
    });
  }
  return out;
}

/**
 * Derive the security profile of a bundle.
 * @param yaml multi-document YAML as it would be applied
 */
export function deriveProfile(yaml: string): SecurityProfile {
  const docs = parseBundle(yaml);
  const profile: SecurityProfile = {
    level: 'plugin',
    kinds: {},
    clusterRules: [],
    namespacedRules: [],
    scc: [],
    hostAccess: [],
    images: [],
    routes: [],
    exposedServices: [],
    secretsInBundle: [],
    networkPolicies: [],
    proxies: [],
    findings: [],
  };
  const findings = profile.findings;
  let level: SecurityLevel = 'plugin';
  const raise = (l: SecurityLevel) => {
    level = maxLevel(level, l);
  };

  const roles = new Map<string, RbacRule[]>(); // "ClusterRole/x" or "Role/ns/x"
  for (const doc of docs) {
    profile.kinds[doc.kind] = (profile.kinds[doc.kind] || 0) + 1;
    if (doc.kind === 'ClusterRole') roles.set(`ClusterRole/${doc.metadata?.name}`, asArray<Obj>(doc.rules).map(normalizeRule));
    if (doc.kind === 'Role') roles.set(`Role/${doc.metadata?.namespace || ''}/${doc.metadata?.name}`, asArray<Obj>(doc.rules).map(normalizeRule));
  }

  // Bindings decide the scope of each role's rules.
  const boundClusterRoles = new Set<string>();
  const bindRole = (roleRef: Obj, scope: string, bindingObj: string) => {
    const refName: string = roleRef?.name || '';
    if (roleRef?.kind === 'ClusterRole') {
      const rules = roles.get(`ClusterRole/${refName}`);
      if (rules) {
        boundClusterRoles.add(refName);
        const target = scope === 'cluster' ? profile.clusterRules : profile.namespacedRules;
        rules.forEach((r) => target.push({ ...r, role: refName, scope }));
        return;
      }
      if (refName.startsWith(SCC_ROLE_PREFIX)) {
        const scc = refName.slice(SCC_ROLE_PREFIX.length);
        profile.scc.push(scc);
        findings.push({ id: 'scc-use', severity: 'high', object: bindingObj, level: 'privileged', message: `Binds SCC role ${refName}.` });
        return;
      }
      const builtin = BUILTIN_ROLE_LEVEL[refName];
      if (builtin) {
        findings.push({
          id: refName === 'cluster-admin' ? 'rbac-binds-cluster-admin' : `rbac-binds-builtin-${refName.replace(/[^a-z0-9]+/g, '-')}`,
          severity: scope === 'cluster' && builtin === 'privileged' ? 'high' : 'warn',
          object: bindingObj,
          // Bound in one namespace, even admin/edit only reach that namespace.
          level: scope === 'cluster' ? builtin : 'namespaced',
          message: `Binds built-in ClusterRole ${refName}${scope === 'cluster' ? ' cluster-wide' : ` in ${scope}`}.`,
        });
        return;
      }
      findings.push({ id: 'rbac-binds-external-role', severity: 'warn', object: bindingObj, level: scope === 'cluster' ? 'cluster-write' : 'namespaced', message: `Binds ClusterRole ${refName}, which is not in the bundle.` });
    } else if (roleRef?.kind === 'Role') {
      const rules = roles.get(`Role/${scope}/${refName}`) || [];
      rules.forEach((r) => profile.namespacedRules.push({ ...r, role: refName, scope }));
    }
  };

  for (const doc of docs) {
    if (doc.kind === 'ClusterRoleBinding') bindRole(doc.roleRef, 'cluster', objName(doc));
    if (doc.kind === 'RoleBinding') bindRole(doc.roleRef, doc.metadata?.namespace || '', objName(doc));
  }
  // ClusterRoles defined but not bound in the bundle may be bound at runtime: treat as cluster-wide (conservative).
  roles.forEach((rules, key) => {
    if (!key.startsWith('ClusterRole/')) return;
    const name = key.slice('ClusterRole/'.length);
    if (boundClusterRoles.has(name)) return;
    rules.forEach((r) => profile.clusterRules.push({ ...r, role: name, scope: 'cluster' }));
    findings.push({ id: 'rbac-unbound-clusterrole', severity: 'info', object: key, message: `ClusterRole ${name} is not bound in the bundle; treated as cluster-wide.` });
  });

  for (const rule of [...profile.clusterRules, ...profile.namespacedRules]) {
    findings.push(...ruleFindings(rule));
    if (rule.scope === 'cluster') raise(isReadOnly(rule) ? 'cluster-read' : 'cluster-write');
    else raise('namespaced');
  }

  for (const doc of docs) {
    const name = doc.metadata?.name || '(unnamed)';
    switch (doc.kind) {
      case 'ServiceAccount':
      case 'Role':
      case 'RoleBinding':
      case 'PersistentVolumeClaim':
        raise('namespaced');
        break;
      case 'CustomResourceDefinition':
        raise('cluster-read');
        break;
      case 'SecurityContextConstraints':
        profile.scc.push(name);
        findings.push({ id: 'scc-defined', severity: 'high', object: objName(doc), level: 'privileged', message: `Bundle defines SCC ${name}.` });
        break;
      case 'Secret': {
        const hasData = Object.keys(doc.data || {}).length > 0 || Object.keys(doc.stringData || {}).length > 0;
        profile.secretsInBundle.push({ name, hasData });
        raise('namespaced');
        if (hasData) {
          findings.push({ id: 'secret-with-data', severity: 'high', object: objName(doc), message: `Secret ${name} ships data in the bundle.` });
        }
        break;
      }
      case 'Route': {
        const route: RouteInfo = {
          name,
          namespace: doc.metadata?.namespace,
          service: doc.spec?.to?.name,
          path: doc.spec?.path,
          tls: !!doc.spec?.tls,
        };
        profile.routes.push(route);
        findings.push({
          id: route.tls ? 'route-exposed' : 'route-exposed-plain-http',
          severity: route.tls ? 'warn' : 'high',
          object: objName(doc),
          message: `Route ${name} exposes ${route.service || 'a service'}${route.path ? ` path ${route.path}` : ' (all paths)'} outside the cluster${route.tls ? '' : ' over plain HTTP'}.`,
        });
        break;
      }
      case 'Service':
        if (doc.spec?.type === 'NodePort' || doc.spec?.type === 'LoadBalancer') {
          profile.exposedServices.push(`${name} (${doc.spec.type})`);
          findings.push({ id: 'service-exposed', severity: 'warn', object: objName(doc), message: `Service ${name} is type ${doc.spec.type}.` });
        }
        break;
      case 'NetworkPolicy':
        profile.networkPolicies.push(name);
        break;
      case 'ConsolePlugin':
        for (const p of asArray<Obj>(doc.spec?.proxy)) {
          const proxy: ProxyInfo = {
            plugin: name,
            alias: p.alias || '',
            service: p.endpoint?.service?.name,
            authorization: p.authorization || 'None',
          };
          profile.proxies.push(proxy);
          if (proxy.authorization !== 'UserToken') {
            findings.push({
              id: 'proxy-no-user-token',
              severity: 'warn',
              object: objName(doc),
              message: `Console proxy "${proxy.alias}" does not forward the user's identity (authorization: UserToken).`,
            });
          }
        }
        break;
      default:
        break;
    }
    for (const holder of podSpecs(doc)) {
      findings.push(...workloadFindings(holder, profile.images, profile.hostAccess));
    }
  }

  if (profile.proxies.length > 0 && profile.networkPolicies.length === 0) {
    findings.push({ id: 'backend-no-networkpolicy', severity: 'warn', object: 'bundle', message: 'Bundle has a backend behind the console proxy but no NetworkPolicy.' });
  }

  for (const f of findings) if (f.level) raise(f.level);
  profile.level = level;
  profile.scc = Array.from(new Set(profile.scc));
  return profile;
}

/** Stable keys for comparing findings against a baseline. */
export function findingKeys(profile: SecurityProfile): string[] {
  return Array.from(new Set(profile.findings.map((f) => `${f.id} ${f.object}`))).sort();
}

function ruleAtoms(rules: RbacRule[]): Set<string> {
  const atoms = new Set<string>();
  for (const r of rules) {
    const groups = r.apiGroups.length ? r.apiGroups : [''];
    const names = r.resourceNames?.length ? r.resourceNames : ['*'];
    for (const g of groups) for (const res of r.resources) for (const v of r.verbs) for (const n of names) atoms.add(`${g || 'core'}/${res} ${v}${n === '*' ? '' : ` ${n}`}`);
    for (const u of r.nonResourceURLs || []) for (const v of r.verbs) atoms.add(`nonResource ${u} ${v}`);
  }
  return atoms;
}

/**
 * RBAC changes between two versions of a bundle, per Role/ClusterRole name.
 * Used to show what an Update would add (the storefront converges RBAC on update).
 */
export function rbacDiff(prevYaml: string, nextYaml: string): { role: string; added: string[]; removed: string[] }[] {
  const collect = (yaml: string) => {
    const m = new Map<string, RbacRule[]>();
    for (const d of parseBundle(yaml)) {
      if (d.kind === 'ClusterRole' || d.kind === 'Role') {
        const key = `${d.kind}/${d.kind === 'Role' ? `${d.metadata?.namespace || ''}/` : ''}${d.metadata?.name}`;
        m.set(key, asArray<Obj>(d.rules).map(normalizeRule));
      }
    }
    return m;
  };
  const prev = collect(prevYaml);
  const next = collect(nextYaml);
  const out: { role: string; added: string[]; removed: string[] }[] = [];
  const roleNames = Array.from(new Set(Array.from(prev.keys()).concat(Array.from(next.keys())))).sort();
  for (const role of roleNames) {
    const a = ruleAtoms(prev.get(role) || []);
    const b = ruleAtoms(next.get(role) || []);
    const added = Array.from(b).filter((x) => !a.has(x)).sort();
    const removed = Array.from(a).filter((x) => !b.has(x)).sort();
    if (added.length || removed.length) out.push({ role, added, removed });
  }
  return out;
}
