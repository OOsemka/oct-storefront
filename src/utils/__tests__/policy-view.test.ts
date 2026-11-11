import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy } from '../policy';
import {
  ADMISSION_POLICIES,
  admissionStatus,
  backendRows,
  bindingMode,
  parseAdmissionParams,
  settingRows,
  SETTING_KEYS,
  toolOverrideRows,
} from '../policy-view';

describe('settingRows', () => {
  it('lists every setting unchanged under the defaults', () => {
    const rows = settingRows({ ...DEFAULT_POLICY });
    expect(rows.map((r) => r.key)).toEqual([...SETTING_KEYS]);
    expect(rows.some((r) => r.changed)).toBe(false);
    expect(rows.find((r) => r.key === 'mode')).toEqual({ key: 'mode', value: 'warn', defaultValue: 'warn', changed: false });
    expect(rows.find((r) => r.key === 'maxLevel')?.value).toBe('');
  });

  it('marks changed values and joins lists', () => {
    const p = parsePolicy('mode: enforce\nmaxLevel: cluster-write\nallowedRegistries: [quay.io/openshift-community-tools, registry.redhat.io]\nallowRoutes: false\n');
    const rows = Object.fromEntries(settingRows(p).map((r) => [r.key, r]));
    expect(rows.mode).toMatchObject({ value: 'enforce', defaultValue: 'warn', changed: true });
    expect(rows.maxLevel).toMatchObject({ value: 'cluster-write', defaultValue: '', changed: true });
    expect(rows.allowedRegistries).toMatchObject({ value: 'quay.io/openshift-community-tools, registry.redhat.io', changed: true });
    expect(rows.allowRoutes).toMatchObject({ value: 'false', defaultValue: 'true', changed: true });
    expect(rows.review.changed).toBe(false);
  });
});

describe('per-tool and backend rows', () => {
  it('are sorted and readable', () => {
    const p = parsePolicy(`
perTool:
  oct-storage-bench: { review: always }
  oct-baremetal: { maxLevel: privileged, allowRoutes: true }
backends:
  oct-shift-on-shift-virt: { authMode: enforce }
  oct-baremetal: { authMode: audit }
`);
    expect(toolOverrideRows(p)).toEqual([
      { tool: 'oct-baremetal', overrides: 'maxLevel: privileged, allowRoutes: true' },
      { tool: 'oct-storage-bench', overrides: 'review: always' },
    ]);
    expect(backendRows(p)).toEqual([
      { extension: 'oct-baremetal', authMode: 'audit' },
      { extension: 'oct-shift-on-shift-virt', authMode: 'enforce' },
    ]);
  });

  it('are empty under the defaults', () => {
    expect(toolOverrideRows({ ...DEFAULT_POLICY })).toEqual([]);
    expect(backendRows({ ...DEFAULT_POLICY })).toEqual([]);
  });
});

describe('admission pack status', () => {
  const all = (actions: string[]) =>
    ADMISSION_POLICIES.map((policyName) => ({
      policyName,
      validationActions: actions,
    }));

  it('maps validationActions to a mode', () => {
    expect(bindingMode(['Warn', 'Audit'])).toBe('warn');
    expect(bindingMode(['Deny', 'Audit'])).toBe('enforce');
    expect(bindingMode(['Deny'])).toBe('enforce');
    expect(bindingMode(['Audit'])).toBe('audit');
    expect(bindingMode([])).toBe('missing');
    expect(bindingMode(undefined)).toBe('missing');
  });

  it('reports the overall state', () => {
    expect(admissionStatus(null).state).toBe('unknown');
    expect(admissionStatus([]).state).toBe('not-installed');
    expect(admissionStatus([{ policyName: 'unrelated', validationActions: ['Deny'] }]).state).toBe('not-installed');
    expect(admissionStatus(all(['Warn', 'Audit'])).state).toBe('warn');
    expect(admissionStatus(all(['Deny', 'Audit'])).state).toBe('enforce');
    expect(admissionStatus(all(['Warn', 'Audit']).slice(1)).state).toBe('partial');
    const mixed = all(['Warn', 'Audit']);
    mixed[0] = { ...mixed[0], validationActions: ['Deny'] };
    const s = admissionStatus(mixed);
    expect(s.state).toBe('mixed');
    expect(s.policies[0]).toEqual({ name: 'oct-no-broad-role-bindings', mode: 'enforce' });
  });

  it('reports a pack from before oct-scc-role-bindings as partial', () => {
    const old = ['oct-no-broad-role-bindings', 'oct-image-rules', 'oct-route-approval', 'oct-scc-changes', 'oct-protect-security-config'];
    const s = admissionStatus(old.map((policyName) => ({ policyName, validationActions: ['Deny', 'Audit'] })));
    expect(s.state).toBe('partial');
    expect(s.policies.find((p) => p.name === 'oct-scc-role-bindings')?.mode).toBe('missing');
  });
});

describe('parseAdmissionParams', () => {
  it('matches the CEL parsing (comma-separated, trimmed, empty dropped)', () => {
    expect(
      parseAdmissionParams({
        allowedRegistries: ' quay.io/openshift-community-tools, ,registry.redhat.io ',
        requireDigest: 'true',
        approvedRoutes: 'oct-baremetal',
        approvedSCCs: '',
        approvedSCCBindings: 'oct-shift-on-shift-virt:anyuid',
      }),
    ).toEqual({
      allowedRegistries: ['quay.io/openshift-community-tools', 'registry.redhat.io'],
      requireDigest: true,
      approvedRoutes: ['oct-baremetal'],
      approvedSCCs: [],
      approvedSCCBindings: ['oct-shift-on-shift-virt:anyuid'],
    });
  });

  it('treats missing data as empty and requireDigest as false unless exactly "true"', () => {
    expect(parseAdmissionParams(undefined)).toEqual({ allowedRegistries: [], requireDigest: false, approvedRoutes: [], approvedSCCs: [], approvedSCCBindings: [] });
    expect(parseAdmissionParams({ requireDigest: 'yes' }).requireDigest).toBe(false);
  });
});
