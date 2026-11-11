/**
 * Pure helpers for the read-only Cluster policy page: the effective storefront
 * policy as rows (value vs default) and the state of the optional admission
 * policy pack (deploy/policy/vap). No cluster calls here; see loadPolicyView()
 * in catalog-actions.ts.
 */
import { DEFAULT_POLICY, Policy, ToolOverride } from './policy';

/** Top-level settings shown on the page, in the order of community-tools-policy.yaml. */
export const SETTING_KEYS = [
  'mode',
  'review',
  'maxLevel',
  'external',
  'externalMaxLevel',
  'publicCatalog',
  'rbacWidening',
  'allowRoutes',
  'requireNetworkPolicy',
  'allowedRegistries',
  'requireDigest',
  'allowedDeployHosts',
  'telemetry',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** What an empty value means, for settings where empty is not "off". */
export const EMPTY_MEANS: Partial<Record<SettingKey, 'no-limit' | 'any'>> = {
  maxLevel: 'no-limit',
  externalMaxLevel: 'no-limit',
  allowedRegistries: 'any',
  allowedDeployHosts: 'any',
};

export type SettingRow = {
  key: SettingKey;
  /** Display value; '' when unset or an empty list (see EMPTY_MEANS). */
  value: string;
  defaultValue: string;
  changed: boolean;
};

function show(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function settingRows(policy: Policy): SettingRow[] {
  return SETTING_KEYS.map((key) => {
    const value = show(policy[key]);
    const defaultValue = show(DEFAULT_POLICY[key]);
    return { key, value, defaultValue, changed: value !== defaultValue };
  });
}

export type ToolOverrideRow = { tool: string; overrides: string };

/** "maxLevel: privileged, allowRoutes: true" per tool, sorted by tool id. */
export function toolOverrideRows(policy: Policy): ToolOverrideRow[] {
  return Object.keys(policy.perTool)
    .sort()
    .map((tool) => {
      const o: ToolOverride = policy.perTool[tool];
      const parts = (Object.keys(o) as (keyof ToolOverride)[]).map((k) => `${k}: ${show(o[k])}`);
      return { tool, overrides: parts.join(', ') };
    });
}

export type BackendRow = { extension: string; authMode: string };

export function backendRows(policy: Policy): BackendRow[] {
  return Object.keys(policy.backends)
    .sort()
    .map((extension) => ({ extension, authMode: policy.backends[extension].authMode }));
}

// ---- Admission policy pack ------------------------------------------------

export const ADMISSION_POLICIES = [
  'oct-no-broad-role-bindings',
  'oct-scc-role-bindings',
  'oct-image-rules',
  'oct-route-approval',
  'oct-scc-changes',
  'oct-protect-security-config',
] as const;
export const ADMISSION_PARAMS_CONFIGMAP = 'oct-admission-params';

export type BindingMode = 'enforce' | 'warn' | 'audit' | 'missing';
/** Overall: unknown = the user can't list bindings; partial = some policies missing. */
export type AdmissionState = 'unknown' | 'not-installed' | 'partial' | 'warn' | 'enforce' | 'audit' | 'mixed';

export type AdmissionBinding = { policyName: string; validationActions: string[] };

export type AdmissionStatus = {
  state: AdmissionState;
  policies: { name: string; mode: BindingMode }[];
};

export function bindingMode(actions: string[] | undefined): BindingMode {
  if (!actions || actions.length === 0) return 'missing';
  if (actions.includes('Deny')) return 'enforce';
  if (actions.includes('Warn')) return 'warn';
  return 'audit';
}

/** Bindings: null when the user isn't allowed to list them. */
export function admissionStatus(bindings: AdmissionBinding[] | null): AdmissionStatus {
  if (bindings == null) {
    return { state: 'unknown', policies: ADMISSION_POLICIES.map((name) => ({ name, mode: 'missing' as BindingMode })) };
  }
  const policies = ADMISSION_POLICIES.map((name) => ({
    name,
    mode: bindingMode(bindings.find((b) => b.policyName === name)?.validationActions),
  }));
  const present = policies.filter((p) => p.mode !== 'missing');
  let state: AdmissionState;
  if (present.length === 0) state = 'not-installed';
  else if (present.length < policies.length) state = 'partial';
  else if (present.every((p) => p.mode === present[0].mode)) state = present[0].mode as AdmissionState;
  else state = 'mixed';
  return { state, policies };
}

export type AdmissionParams = {
  allowedRegistries: string[];
  requireDigest: boolean;
  approvedRoutes: string[];
  approvedSCCs: string[];
  approvedSCCBindings: string[];
};

/** Same parsing as the CEL in deploy/policy/vap/base: comma-separated, trimmed, empty entries dropped. */
export function parseAdmissionParams(data: Record<string, string> | undefined): AdmissionParams {
  const list = (k: string) =>
    (data?.[k] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    allowedRegistries: list('allowedRegistries'),
    requireDigest: data?.requireDigest === 'true',
    approvedRoutes: list('approvedRoutes'),
    approvedSCCs: list('approvedSCCs'),
    approvedSCCBindings: list('approvedSCCBindings'),
  };
}
