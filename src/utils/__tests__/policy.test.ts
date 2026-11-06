import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluate, InstallContext, parsePolicy, Policy, telemetryAllows } from '../policy';
import { deriveProfile, SecurityProfile } from '../security-profile';

const deploy = (name: string) => readFileSync(join(__dirname, '../../../catalog/deploy', `${name}.yaml`), 'utf8');

const PLUGIN_ONLY = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: oct-x, namespace: oct-x }
spec:
  template:
    spec:
      containers: [{ name: p, image: "quay.io/example/oct-x:1.0.0-ocp4.22" }]
---
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata: { name: oct-x }
spec: { backend: { type: Service, service: { name: oct-x, namespace: oct-x, port: 9443 } } }
`;

function ctx(profile: SecurityProfile, extra: Partial<InstallContext> = {}): InstallContext {
  return { toolId: 'oct-x', source: 'community', action: 'add', profile, ...extra };
}
const policy = (yaml: string): Policy => parsePolicy(yaml);

describe('parsePolicy', () => {
  it('returns the defaults for an absent or empty policy', () => {
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(parsePolicy('')).toEqual(DEFAULT_POLICY);
    expect(parsePolicy('# only comments\n')).toEqual(DEFAULT_POLICY);
  });

  it('the shipped example (deploy/policy) equals the defaults', () => {
    const cm = load(readFileSync(join(__dirname, '../../../deploy/policy/community-tools-policy.yaml'), 'utf8')) as {
      data: Record<string, string>;
    };
    const w: string[] = [];
    expect(parsePolicy(cm.data['policy.yaml'], w)).toEqual(DEFAULT_POLICY);
    expect(w).toEqual([]);
  });

  it('never throws; invalid values fall back with warnings', () => {
    const w: string[] = [];
    const p = parsePolicy('mode: lockdown\nreview: always\nallowRoutes: "no"\nmaxLevel: root\n', w);
    expect(p.mode).toBe('warn');
    expect(p.review).toBe('always');
    expect(p.allowRoutes).toBe(true);
    expect(p.maxLevel).toBeUndefined();
    expect(w).toHaveLength(3);
    const w2: string[] = [];
    expect(parsePolicy('mode: [unclosed', w2)).toEqual(DEFAULT_POLICY);
    expect(w2[0]).toMatch(/not valid YAML/);
    expect(parsePolicy('- a list', w2)).toEqual(DEFAULT_POLICY);
  });

  it('accepts backend overrides of audit or enforce only', () => {
    const w: string[] = [];
    const p = parsePolicy('backends:\n  oct-baremetal: { authMode: audit }\n  oct-x: { authMode: off }\n  Bad_Name: { authMode: audit }\n', w);
    expect(p.backends).toEqual({ 'oct-baremetal': { authMode: 'audit' } });
    expect(w).toHaveLength(2);
  });

  it('parses per-tool overrides', () => {
    const p = parsePolicy('maxLevel: namespaced\nperTool:\n  oct-baremetal: { maxLevel: privileged, allowRoutes: true }\n');
    expect(p.perTool['oct-baremetal']).toEqual({ maxLevel: 'privileged', allowRoutes: true });
  });
});

describe('evaluate: defaults keep today\'s behaviour', () => {
  it('allows a plugin-only tool with no review', () => {
    const d = evaluate(DEFAULT_POLICY, ctx(deriveProfile(PLUGIN_ONLY)));
    expect(d).toEqual({ outcome: 'allow', review: false, reasons: [] });
  });

  it.each(['oct-baremetal', 'oct-shift-on-shift-virt', 'oct-storage-bench', 'oct-windows-builder'])(
    'never blocks %s, but shows the review screen',
    (name) => {
      const d = evaluate(DEFAULT_POLICY, ctx(deriveProfile(deploy(name)), { toolId: name }));
      expect(d.outcome).not.toBe('block');
      expect(d.review).toBe(true);
    },
  );

  it('reviews external and public-only tools even when plugin-only', () => {
    const p = deriveProfile(PLUGIN_ONLY);
    expect(evaluate(DEFAULT_POLICY, ctx(p, { source: 'external' })).review).toBe(true);
    expect(evaluate(DEFAULT_POLICY, ctx(p, { publicOnly: true })).review).toBe(true);
  });

  it('review: never with mode: off is exactly today (no screen, no reasons)', () => {
    const p = policy('mode: off\nreview: never\nmaxLevel: plugin\nallowRoutes: false\n');
    const d = evaluate(p, ctx(deriveProfile(deploy('oct-baremetal'))));
    expect(d).toEqual({ outcome: 'allow', review: false, reasons: [] });
  });
});

describe('evaluate: modes', () => {
  const bm = () => deriveProfile(deploy('oct-baremetal'));

  it('warn turns a block into a review with an explanation', () => {
    const d = evaluate(policy('maxLevel: namespaced'), ctx(bm()));
    expect(d.outcome).toBe('review');
    expect(d.reasons.find((r) => r.id === 'max-level')?.message).toMatch(/enforce mode/);
  });

  it('enforce blocks', () => {
    const d = evaluate(policy('mode: enforce\nmaxLevel: namespaced'), ctx(bm()));
    expect(d.outcome).toBe('block');
    expect(d.review).toBe(true);
  });

  it('a per-tool exception lifts the limit for that tool only', () => {
    const p = policy('mode: enforce\nmaxLevel: namespaced\nperTool:\n  oct-baremetal: { maxLevel: privileged }\n');
    expect(evaluate(p, ctx(bm(), { toolId: 'oct-baremetal' })).outcome).not.toBe('block');
    expect(evaluate(p, ctx(bm(), { toolId: 'oct-other' })).outcome).toBe('block');
  });

  it('review: always shows the screen for plugin-only tools', () => {
    expect(evaluate(policy('review: always'), ctx(deriveProfile(PLUGIN_ONLY))).review).toBe(true);
  });
});

describe('evaluate: individual rules (enforce)', () => {
  const enforce = (y: string) => policy(`mode: enforce\n${y}`);
  const plugin = () => deriveProfile(PLUGIN_ONLY);

  it('external: block / review', () => {
    expect(evaluate(enforce('external: block'), ctx(plugin(), { source: 'external' })).outcome).toBe('block');
    expect(evaluate(enforce('external: review'), ctx(plugin(), { source: 'external' })).outcome).toBe('review');
    expect(evaluate(enforce('external: block'), ctx(plugin())).outcome).toBe('allow');
  });

  it('externalMaxLevel applies to external tools only', () => {
    const p = enforce('externalMaxLevel: plugin');
    const sos = deriveProfile(deploy('oct-shift-on-shift-virt'));
    expect(evaluate(p, ctx(sos, { source: 'external' })).outcome).toBe('block');
    expect(evaluate(p, ctx(sos)).outcome).toBe('allow');
  });

  it('allowRoutes: false blocks bundles with a Route', () => {
    const bm = deriveProfile(deploy('oct-baremetal'));
    expect(bm.routes.length).toBeGreaterThan(0);
    expect(evaluate(enforce('allowRoutes: false'), ctx(bm)).reasons.map((r) => r.id)).toContain('route');
  });

  it('allowedRegistries matches by prefix, not substring', () => {
    expect(evaluate(enforce('allowedRegistries: [quay.io/example]'), ctx(plugin())).outcome).toBe('allow');
    expect(evaluate(enforce('allowedRegistries: [quay.io/exam]'), ctx(plugin())).outcome).toBe('block');
    expect(evaluate(enforce('allowedRegistries: [quay.io]'), ctx(plugin())).outcome).toBe('allow');
  });

  it('requireDigest: community spares external tools; all does not', () => {
    expect(evaluate(enforce('requireDigest: community'), ctx(plugin())).outcome).toBe('block');
    expect(evaluate(enforce('requireDigest: community'), ctx(plugin(), { source: 'external' })).reasons.map((r) => r.id)).not.toContain('digest');
    expect(evaluate(enforce('requireDigest: all'), ctx(plugin(), { source: 'external' })).reasons.map((r) => r.id)).toContain('digest');
  });

  it('allowedDeployHosts checks the manifest host', () => {
    const p = enforce('allowedDeployHosts: [raw.githubusercontent.com]');
    expect(evaluate(p, ctx(plugin(), { deployURL: 'https://raw.githubusercontent.com/x/y.yaml' })).outcome).toBe('allow');
    expect(evaluate(p, ctx(plugin(), { deployURL: 'https://evil.example/y.yaml' })).outcome).toBe('block');
  });

  it('requireNetworkPolicy flags proxied backends without one', () => {
    const bm = deriveProfile(deploy('oct-baremetal'));
    expect(evaluate(enforce('requireNetworkPolicy: true'), ctx(bm)).reasons.map((r) => r.id)).toContain('network-policy');
  });

  it('rbacWidening applies to updates that add permissions', () => {
    const added = [{ role: 'ClusterRole/oct-x', added: ['get secrets'] }];
    expect(evaluate(enforce('rbacWidening: block'), ctx(plugin(), { action: 'update', rbacAdded: added })).outcome).toBe('block');
    expect(evaluate(enforce('rbacWidening: block'), ctx(plugin(), { action: 'add', rbacAdded: added })).outcome).toBe('allow');
    expect(evaluate(DEFAULT_POLICY, ctx(plugin(), { action: 'update', rbacAdded: added })).review).toBe(true);
  });

  it('flags a profile above the declared level, but a declaration never relaxes a rule', () => {
    const sos = deriveProfile(deploy('oct-shift-on-shift-virt'));
    const d = evaluate(DEFAULT_POLICY, ctx(sos, { declared: { schema: 1, level: 'plugin' } }));
    expect(d.reasons.map((r) => r.id)).toContain('exceeds-declaration');
    const strict = evaluate(enforce('maxLevel: plugin'), ctx(sos, { declared: { schema: 1, level: 'plugin' } }));
    expect(strict.outcome).toBe('block');
  });
});

describe('telemetryAllows', () => {
  it('follows the telemetry knob', () => {
    expect(telemetryAllows(DEFAULT_POLICY, 'download')).toBe(true);
    expect(telemetryAllows(policy('telemetry: ratings-only'), 'download')).toBe(false);
    expect(telemetryAllows(policy('telemetry: ratings-only'), 'rating')).toBe(true);
    expect(telemetryAllows(policy('telemetry: off'), 'rating')).toBe(false);
  });
});
