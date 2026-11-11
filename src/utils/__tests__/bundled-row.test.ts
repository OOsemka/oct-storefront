import { describe, expect, it, vi } from 'vitest';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: vi.fn(),
  k8sDelete: vi.fn(),
  k8sGet: vi.fn(),
  k8sListItems: vi.fn(),
  k8sPatch: vi.fn(),
  k8sUpdate: vi.fn(),
}));

// The catalog files are webpack-loaded YAML text in the app; give vitest the same text.
vi.mock('../../../catalog/community.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/community.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-baremetal.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-baremetal.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-network-bond.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-network-bond.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-banner.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-banner.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-windows-builder.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-windows-builder.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-storage-bench.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-storage-bench.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-odf-macvlans.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-odf-macvlans.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-hello-world.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-hello-world.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-network-bridge.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-network-bridge.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-network-dhcp.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-network-dhcp.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-network-vlan.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-network-vlan.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-shift-on-shift-virt.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-shift-on-shift-virt.yaml', import.meta.url), 'utf8') }));
vi.mock('../../../catalog/deploy/oct-must-gather.yaml', async () => ({ default: (await import('fs')).readFileSync(new URL('../../../catalog/deploy/oct-must-gather.yaml', import.meta.url), 'utf8') }));

import { bundledCommunityTools, manifestsWithheld, matchesBundledRow, telemetryPolicy } from '../catalog-actions';
import { DEFAULT_POLICY } from '../policy';

describe('matchesBundledRow (review finding B3)', () => {
  const tool = bundledCommunityTools().find((t) => t.metadata.name === 'oct-hello-world')!;
  const row = tool.spec.versions![tool.spec.versions!.length - 1];

  it('accepts a row exactly as bundled', () => {
    expect(matchesBundledRow(tool, row)).toBe(true);
  });
  it('rejects a row whose image or manifest differs (for example edited in the cache)', () => {
    expect(matchesBundledRow(tool, { ...row, image: 'quay.io/evil/hello:1' })).toBe(false);
    expect(matchesBundledRow(tool, { ...row, deployYAML: 'kind: Namespace' })).toBe(false);
    expect(matchesBundledRow(tool, { ...row, version: '99.0.0' })).toBe(false);
    // spec.image only matters when the row has no image of its own (it is the fallback).
    expect(matchesBundledRow({ ...tool, spec: { ...tool.spec, image: 'quay.io/evil/x:1' } }, { ...row, image: undefined })).toBe(false);
  });
  it('accepts the synced cache shape: one row for several minors (real regression on 2026-11-10)', () => {
    const minors = tool.spec.versions!.filter((v) => v.version === row.version);
    const merged = { ...minors[0], openshift: ['4.21', '4.22'] as unknown as string[] };
    expect(matchesBundledRow(tool, merged, '4.22')).toBe(true);
    expect(matchesBundledRow(tool, merged, '4.21')).toBe(true);
    expect(matchesBundledRow(tool, { ...merged, image: 'quay.io/evil/hello:1.0.0-ocp4.21' }, '4.22')).toBe(false);
  });
  it('rejects tools that are not bundled at all', () => {
    expect(matchesBundledRow({ ...tool, metadata: { name: 'oct-not-bundled' } }, row)).toBe(false);
  });
});

describe('telemetryPolicy', () => {
  it('sends nothing when the policy could not be read', () => {
    expect(telemetryPolicy({ policy: DEFAULT_POLICY, policySource: 'error' })).toBeUndefined();
    expect(telemetryPolicy({ policy: DEFAULT_POLICY, policySource: 'default' })).toBe(DEFAULT_POLICY);
    expect(telemetryPolicy({ policy: DEFAULT_POLICY, policySource: 'configmap' })).toBe(DEFAULT_POLICY);
  });
});

describe('manifestsWithheld (publicCatalog other than full)', () => {
  const sf = bundledCommunityTools().find((t) => t.metadata.name === 'oct-storefront')!;
  const newer = { version: '9.9.9', openshift: '4.22', image: 'quay.io/openshift-community-tools/oct-storefront:9.9.9-ocp4.22' };
  const ctx = (publicCatalog: 'full' | 'metadata-only' | 'off') => ({ publicOnly: false, unverifiedRow: true, publicCatalog });

  it("refuses a synced storefront row whose manifest was removed (it would get generated manifests)", () => {
    expect(manifestsWithheld(sf, newer, ctx('metadata-only'))).toBe(true);
  });
  it('allows it with publicCatalog: full, or when the row still has a manifest', () => {
    expect(manifestsWithheld(sf, newer, ctx('full'))).toBe(false);
    expect(manifestsWithheld(sf, { ...newer, deployURL: 'https://example.com/upgrade.yaml' }, ctx('metadata-only'))).toBe(false);
  });
  it('leaves bundled rows and tools that never ship manifests alone', () => {
    expect(manifestsWithheld(sf, newer, { ...ctx('metadata-only'), unverifiedRow: false })).toBe(false);
    const plain = { ...sf, metadata: { name: 'oct-plain-plugin' }, spec: { ...sf.spec, consolePlugin: 'oct-plain-plugin', versions: [], deployURL: undefined, deployYAML: undefined } };
    expect(manifestsWithheld(plain, newer, ctx('metadata-only'))).toBe(false);
    expect(manifestsWithheld(plain, newer, { ...ctx('metadata-only'), publicOnly: true })).toBe(true);
  });
});
