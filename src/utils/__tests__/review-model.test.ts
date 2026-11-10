import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluate, parsePolicy } from '../policy';
import { buildReview, ruleText, whyFor } from '../review-model';
import { deriveProfile } from '../security-profile';

const deploy = (name: string) => readFileSync(join(__dirname, '../../../catalog/deploy', `${name}.yaml`), 'utf8');

describe('ruleText', () => {
  it('describes resource and URL rules', () => {
    expect(ruleText({ verbs: ['get', 'list'], resources: ['secrets'], apiGroups: [''] })).toBe('get, list on secrets');
    expect(ruleText({ verbs: ['get'], resources: ['consoles'], apiGroups: ['operator.openshift.io'], resourceNames: ['cluster'] })).toBe(
      'get on consoles named cluster (operator.openshift.io)',
    );
    expect(ruleText({ verbs: ['*'], resources: ['*'], apiGroups: ['*'] })).toBe('* on * (all API groups)');
    expect(ruleText({ verbs: ['get'], resources: [], apiGroups: [], nonResourceURLs: ['/metrics'] })).toBe('get on URLs /metrics');
  });
});

describe('whyFor', () => {
  const rule = { role: 'ClusterRole/x', scope: 'cluster', verbs: ['get'], resources: ['nodes'], apiGroups: [''] };
  it('matches a declared rule by resource and group', () => {
    expect(whyFor(rule, [{ apiGroups: [''], resources: ['nodes'], verbs: ['get'], why: 'show node NICs' }])).toBe('show node NICs');
    expect(whyFor(rule, [{ apiGroups: ['apps'], resources: ['nodes'], verbs: ['get'], why: 'x' }])).toBeUndefined();
    expect(whyFor(rule, undefined)).toBeUndefined();
  });
  it('covers subresources with the parent resource', () => {
    const sub = { role: 'ClusterRole/x', scope: 'cluster', verbs: ['create'], resources: ['virtualmachines/start'], apiGroups: ['subresources.kubevirt.io'] };
    expect(whyFor(sub, [{ apiGroups: ['subresources.kubevirt.io'], resources: ['virtualmachines'], verbs: ['create'], why: 'power VMs' }])).toBe('power VMs');
  });
  it('treats "" as the core group, not as any group', () => {
    const pods = { role: 'ClusterRole/x', scope: 'cluster', verbs: ['get'], resources: ['pods'], apiGroups: [''] };
    expect(whyFor(pods, [{ apiGroups: ['', 'apps'], resources: ['pods'], verbs: ['get'], why: 'logs' }])).toBe('logs');
    expect(whyFor(pods, [{ apiGroups: ['apps'], resources: ['pods'], verbs: ['get'], why: 'x' }])).toBeUndefined();
  });
});

describe('buildReview', () => {
  it('summarises a privileged bundle with routes, images and findings', () => {
    const profile = deriveProfile(deploy('oct-baremetal'));
    const m = buildReview({ profile, decision: evaluate(DEFAULT_POLICY, { toolId: 'oct-baremetal', source: 'community', action: 'add', profile }) });
    expect(m.level).toBe('privileged');
    expect(m.declared).toBe(false);
    expect(m.blocked).toBe(false);
    expect(m.network.some((n) => n.startsWith('Route '))).toBe(true);
    expect(m.images.length).toBeGreaterThan(0);
    expect(m.findings.every((f) => f.severity !== 'info')).toBe(true);
    const sev = m.findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === 'high' ? -1 : 1)));
    expect(sev[0]).toBe('high');
    expect(m.kinds.some((k) => k.endsWith('× Deployment'))).toBe(true);
  });

  it('puts blocking reasons first and marks the install blocked', () => {
    const profile = deriveProfile(deploy('oct-baremetal'));
    const policy = parsePolicy('mode: enforce\nmaxLevel: namespaced\n');
    const decision = evaluate(policy, { toolId: 'oct-baremetal', source: 'community', action: 'add', profile, declared: { schema: 1, level: 'plugin' } });
    const m = buildReview({ profile, decision, declared: { schema: 1, level: 'plugin' } });
    expect(m.blocked).toBe(true);
    expect(m.reasons[0].gate).toBe('block');
    expect(m.declaredLevel).toBe('plugin');
  });

  it('lists RBAC changes and declared runtime objects', () => {
    const profile = deriveProfile(deploy('oct-hello-world'));
    const m = buildReview({
      profile,
      decision: { outcome: 'allow', review: false, reasons: [] },
      declared: { schema: 1, privileged: { scc: [], hostAccess: [], runtimeCreates: [{ kind: 'SecurityContextConstraints', name: 'x', cleanup: 'on remove' }] } },
      rbacChanges: [{ role: 'ClusterRole/a', added: ['get secrets'], removed: ['list pods'] }],
    });
    expect(m.rbacAdded).toEqual(['ClusterRole/a: get secrets']);
    expect(m.rbacRemoved).toEqual(['ClusterRole/a: list pods']);
    expect(m.runtimeCreates[0]).toMatch(/SecurityContextConstraints\/x.*cleanup: on remove/);
  });
});

describe('whyFor (review finding: wildcard reasons)', () => {
  const rule = (resources: string[], apiGroups: string[] = ['']) => ({ apiGroups, resources, verbs: ['get'], role: 'r', scope: 'cluster' });
  it('a declared wildcard explains only a derived wildcard', () => {
    const declared = [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'], why: 'everything' }];
    expect(whyFor(rule(['secrets']), declared)).toBeUndefined();
    expect(whyFor(rule(['*'], ['*']), declared)).toBe('everything');
  });
  it('a specific declared resource explains itself and its subresources, not a wildcard', () => {
    const declared = [{ apiGroups: ['kubevirt.io'], resources: ['virtualmachines'], verbs: ['get'], why: 'VMs' }];
    expect(whyFor(rule(['virtualmachines/start'], ['kubevirt.io']), declared)).toBe('VMs');
    expect(whyFor(rule(['*'], ['kubevirt.io']), declared)).toBeUndefined();
  });
});
