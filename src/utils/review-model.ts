/**
 * What the install review screen shows, as plain data (InstallReviewModal renders it).
 * Pure module: no console SDK imports, unit-tested.
 */
import type { Decision, Reason } from './policy';
import type { ImageRef, ProfileFinding, ScopedRule, SecurityLevel, SecurityProfile } from './security-profile';
import type { DeclaredRule, SecuritySpec } from './security-spec';

export const LEVEL_TEXT: Record<SecurityLevel, string> = {
  plugin: 'Console plugin only.',
  namespaced: 'Also permissions or storage inside its own namespace.',
  'cluster-read': 'Can read resources across the cluster.',
  'cluster-write': 'Can change resources across the cluster.',
  privileged: 'Privileged: host access, SCCs, secrets cluster-wide, or permissions that amount to cluster admin.',
};

export type ReviewRule = { text: string; scope: string; role: string; why?: string };

export type ReviewModel = {
  level: SecurityLevel;
  levelText: string;
  declaredLevel?: SecurityLevel;
  summary?: string;
  contact?: string;
  declared: boolean;
  /** Policy reasons, strictest first. */
  reasons: Reason[];
  blocked: boolean;
  kinds: string[];
  clusterRules: ReviewRule[];
  namespacedRules: ReviewRule[];
  privileged: string[];
  network: string[];
  images: Array<{ ref: string; note: string }>;
  findings: ProfileFinding[];
  rbacAdded: string[];
  rbacRemoved: string[];
  /** Objects the declaration says the plugin creates at runtime (not in the YAML). */
  runtimeCreates: string[];
};

const GATE_ORDER: Record<string, number> = { block: 0, review: 1, warn: 2, allow: 3 };
const SEVERITY_ORDER: Record<string, number> = { high: 0, warn: 1, info: 2 };

function groupLabel(groups: string[]): string {
  const named = groups.filter((g) => g && g !== '*');
  if (groups.includes('*')) return ' (all API groups)';
  return named.length ? ` (${named.join(', ')})` : '';
}

export function ruleText(r: { verbs: string[]; resources: string[]; apiGroups: string[]; resourceNames?: string[]; nonResourceURLs?: string[] }): string {
  if (r.nonResourceURLs?.length) return `${r.verbs.join(', ')} on URLs ${r.nonResourceURLs.join(', ')}`;
  const names = r.resourceNames?.length ? ` named ${r.resourceNames.join(', ')}` : '';
  return `${r.verbs.join(', ')} on ${r.resources.join(', ') || '(none)'}${names}${groupLabel(r.apiGroups)}`;
}

/**
 * The contributor's reason for a derived rule: a declared rule sharing a resource and
 * API group. A declared resource also covers its subresources (`virtualmachines`
 * explains `virtualmachines/start`).
 */
export function whyFor(rule: ScopedRule, declared: DeclaredRule[] | undefined): string | undefined {
  if (!declared?.length) return undefined;
  const parents = rule.resources.map((r) => r.split('/')[0]);
  const hit = declared.find(
    (d) =>
      d.why &&
      d.resources.some(
        (res) => res === '*' || rule.resources.includes(res) || parents.includes(res) || rule.resources.includes('*'),
      ) &&
      (d.apiGroups.length === 0 || d.apiGroups.some((g) => g === '*' || rule.apiGroups.includes(g) || rule.apiGroups.includes('*'))),
  );
  return hit?.why;
}

function imageNote(i: ImageRef): string {
  const parts = [i.digest ? 'pinned by digest' : 'tag only (can change)'];
  if (i.registry) parts.push(i.registry);
  return parts.join(', ');
}

export function buildReview(input: {
  profile: SecurityProfile;
  declared?: SecuritySpec;
  decision: Decision;
  rbacChanges?: { role: string; added: string[]; removed: string[] }[];
}): ReviewModel {
  const { profile, declared, decision } = input;
  const declaredRules = declared?.rbac?.rules;
  const toRule = (r: ScopedRule): ReviewRule => ({
    text: ruleText(r),
    scope: r.scope,
    role: r.role,
    why: whyFor(r, declaredRules),
  });

  const privileged: string[] = [];
  profile.scc.forEach((s) => privileged.push(`Uses SCC ${s}`));
  profile.hostAccess.forEach((h) => privileged.push(h));

  const network: string[] = [];
  profile.routes.forEach((r) =>
    network.push(`Route ${r.name}${r.path ? ` (path ${r.path})` : ''}${r.tls ? '' : ', plain HTTP'}: reachable from outside the cluster`),
  );
  profile.exposedServices.forEach((s) => network.push(`Service ${s} exposed on the node network`));
  profile.proxies.forEach((p) =>
    network.push(
      `Console proxy to ${p.service || p.alias}: ${p.authorization === 'UserToken' ? "forwards the user's identity" : "does not forward the user's identity"}`,
    ),
  );
  if (profile.networkPolicies.length) network.push(`NetworkPolicy: ${profile.networkPolicies.join(', ')}`);
  (declared?.network?.egress || []).forEach((e) => network.push(`Declared outbound access to ${e.host}${e.why ? `: ${e.why}` : ''}`));

  const kinds = Object.keys(profile.kinds)
    .sort()
    .map((k) => `${profile.kinds[k]} × ${k}`);

  const added: string[] = [];
  const removed: string[] = [];
  (input.rbacChanges || []).forEach((c) => {
    c.added.forEach((a) => added.push(`${c.role}: ${a}`));
    c.removed.forEach((a) => removed.push(`${c.role}: ${a}`));
  });

  return {
    level: profile.level,
    levelText: LEVEL_TEXT[profile.level],
    declaredLevel: declared?.level,
    summary: declared?.summary,
    contact: declared?.contact,
    declared: Boolean(declared),
    reasons: [...decision.reasons].sort((a, b) => GATE_ORDER[a.gate] - GATE_ORDER[b.gate]),
    blocked: decision.outcome === 'block',
    kinds,
    clusterRules: profile.clusterRules.map(toRule),
    namespacedRules: profile.namespacedRules.map(toRule),
    privileged,
    network,
    images: profile.images.map((i) => ({ ref: i.ref, note: imageNote(i) })),
    // Highest severity first; original order within a severity.
    findings: profile.findings
      .filter((f) => f.severity !== 'info')
      .map((f, i) => ({ f, i }))
      .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
      .map(({ f }) => f),
    rbacAdded: added,
    rbacRemoved: removed,
    runtimeCreates: (declared?.privileged?.runtimeCreates || []).map(
      (o) => `${o.kind}/${o.name}${o.why ? `: ${o.why}` : ''}${o.cleanup ? ` (cleanup: ${o.cleanup})` : ''}`,
    ),
  };
}
