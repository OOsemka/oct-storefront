import { describe, expect, it } from 'vitest';
import { parseSecurity, securityToJson } from '../security-spec';
import { mergePublicIntoTool, parseSingleTool, parseToolList, toCommunityYaml, toolFromPublic } from '../parse-tools';
import { storefrontBlocker } from '../bundle-check';

const FULL = `
apiVersion: communitytools.io/v1alpha1
kind: CommunityTool
metadata:
  name: oct-demo
spec:
  displayName: Demo
  description: "A demo"
  category: network
  consolePlugin: oct-demo
  security:
    schema: 1
    level: namespaced
    summary: "Reads NNCPs"
    contact: https://github.com/example/oct-demo/security/advisories
    backend:
      services: [oct-demo-backend]
      auth: ssar
      authModeDefault: enforce
      publicPaths: [/healthz]
    network:
      ingress: console-only
      networkPolicy: true
      routes: []
      egress: [{ host: quay.io, why: images }]
    rbac:
      rules:
        - apiGroups: [nmstate.io]
          resources: [nodenetworkconfigurationpolicies]
          verbs: [get, list]
          why: show current policies
    privileged:
      scc: []
      hostAccess: []
      runtimeCreates: [{ kind: SecurityContextConstraints, name: oct-demo, cleanup: deleted on uninstall, why: dhcp }]
    secrets: { access: none }
    supplyChain: { digestPinned: true, signed: none }
    futureKey: { anything: [1, 2] }
  versions:
    - version: "1.0.0"
      openshift: ["4.21", "4.22"]
      image: quay.io/example/oct-demo:1.0.0-ocp4.22
      minStorefront: "1.6.0"
      security: { schema: 1, level: cluster-read }
`;

describe('parseSecurity', () => {
  it('is undefined when absent and never throws on junk', () => {
    const w: string[] = [];
    expect(parseSecurity(undefined, w)).toBeUndefined();
    expect(parseSecurity('nope', w)).toBeUndefined();
    expect(parseSecurity([1], w)).toBeUndefined();
    expect(w).toHaveLength(2);
  });

  it('drops invalid enum values with a warning', () => {
    const w: string[] = [];
    const s = parseSecurity({ level: 'root', backend: { auth: 'magic', services: 'x' } }, w);
    expect(s).toEqual({ schema: 1, backend: { services: [], publicPaths: [] } });
    expect(w.join(' ')).toMatch(/level "root"/);
  });

  it('keeps unknown keys in extra and caps their size', () => {
    const w: string[] = [];
    expect(parseSecurity({ newThing: { a: 1 } }, w)?.extra).toEqual({ newThing: { a: 1 } });
    expect(parseSecurity({ big: 'x'.repeat(20000) }, w)?.extra).toBeUndefined();
    expect(w.join(' ')).toMatch(/16 KB/);
  });

  it('keeps "" (the core API group) in declared rules', () => {
    const s = parseSecurity({ rbac: { rules: [{ apiGroups: ['', 'apps'], resources: ['pods'], verbs: ['get'] }] } });
    expect(s?.rbac?.rules[0].apiGroups).toEqual(['', 'apps']);
  });

  it('warns on a newer schema but keeps the block', () => {
    const w: string[] = [];
    expect(parseSecurity({ schema: 2, level: 'plugin' }, w)?.level).toBe('plugin');
    expect(w.join(' ')).toMatch(/schema 2/);
  });

  it('securityToJson merges extra back without overriding known keys', () => {
    expect(securityToJson({ schema: 1, level: 'plugin', extra: { level: 'x', more: true } })).toEqual({
      schema: 1,
      level: 'plugin',
      more: true,
    });
  });
});

describe('catalog round-trip', () => {
  it('parses, serializes and re-parses spec.security without loss', () => {
    const [tool] = parseToolList(FULL, 'community');
    expect(tool.spec.security?.level).toBe('namespaced');
    expect(tool.spec.security?.rbac?.rules[0].why).toBe('show current policies');
    expect(tool.spec.security?.extra).toEqual({ futureKey: { anything: [1, 2] } });
    expect(tool.spec.versions?.[0].minStorefront).toBe('1.6.0');
    expect(tool.spec.versions?.[0].security?.level).toBe('cluster-read');

    const yaml = toCommunityYaml([tool]);
    const [again] = parseToolList(yaml, 'community');
    expect(again.spec.security).toEqual(tool.spec.security);
    // (the serializer already fills in the default channel; unrelated to security)
    expect(again.spec.versions?.[0].security).toEqual(tool.spec.versions?.[0].security);
    expect(again.spec.versions?.[0].minStorefront).toBe('1.6.0');
    expect(toCommunityYaml([again])).toBe(yaml);
  });

  it('serializes a tool without security exactly as before', () => {
    const plain = FULL.replace(/  security:[\s\S]*?(?=  versions:)/, '').replace(/      minStorefront.*\n      security.*\n/, '');
    const [tool] = parseToolList(plain, 'community');
    expect(tool.spec.security).toBeUndefined();
    const yaml = toCommunityYaml([tool]);
    expect(yaml).not.toMatch(/security|minStorefront/);
  });
});

describe('public catalog merge', () => {
  const [bundled] = parseToolList(FULL, 'community');

  it('keeps the bundled declaration when the public entry has none', () => {
    const merged = mergePublicIntoTool(bundled, { id: 'oct-demo', versions: [{ version: '1.0.0', openshift: '4.22' }] });
    expect(merged.spec.security?.level).toBe('namespaced');
    expect(merged.spec.versions?.[0].security?.level).toBe('cluster-read');
    expect(merged.spec.versions?.[0].minStorefront).toBe('1.6.0');
  });

  it('lets a public declaration win', () => {
    const merged = mergePublicIntoTool(bundled, { id: 'oct-demo', security: { schema: 1, level: 'privileged' } });
    expect(merged.spec.security?.level).toBe('privileged');
  });

  it('parses a declaration on a public-only tool', () => {
    const tool = toolFromPublic({ id: 'oct-new', security: { level: 'plugin' } });
    expect(tool?.spec.security).toEqual({ schema: 1, level: 'plugin' });
  });
});

describe('parseSingleTool warnings', () => {
  const external = (extra: string) => `
apiVersion: communitytools.io/v1alpha1
kind: CommunityTool
metadata: { name: oct-ext }
spec:
  consolePlugin: oct-ext
  versions: [{ version: "1.0.0", openshift: "4.22", image: "quay.io/x/oct-ext:1.0.0-ocp4.22" }]
${extra}`;

  it('warns, but does not fail, when undeclared', () => {
    const r = parseSingleTool(external(''));
    expect(r.error).toBeUndefined();
    expect(r.warnings?.join(' ')).toMatch(/No spec.security/);
  });

  it('warns, but does not fail, on a malformed block', () => {
    const r = parseSingleTool(external('  security: "everything"'));
    expect(r.error).toBeUndefined();
    expect(r.tool).toBeDefined();
    expect(r.warnings?.join(' ')).toMatch(/must be a mapping/);
  });

  it('has no warnings for a valid declaration', () => {
    const r = parseSingleTool(external('  security: { level: plugin }'));
    expect(r.warnings).toEqual([]);
  });
});

describe('storefrontBlocker', () => {
  it('blocks only rows that need a newer storefront', () => {
    expect(storefrontBlocker('Demo', '1.5.17', undefined)).toBe('');
    expect(storefrontBlocker('Demo', '1.5.17', '1.5.17')).toBe('');
    expect(storefrontBlocker('Demo', '1.6.0', '1.5.0')).toBe('');
    expect(storefrontBlocker('Demo', '1.5.17', '1.6.0')).toMatch(/needs storefront 1.6.0/);
  });
});
