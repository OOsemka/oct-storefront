import { k8sGet, k8sPatch, K8sModel, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { CommunityTool } from './catalog-types';

export const MACHINE_API_NS = 'openshift-machine-api';
export const PROVISIONING_NAME = 'provisioning-configuration';
export const PROVISIONING_GVK = {
  group: 'metal3.io',
  version: 'v1alpha1',
  kind: 'Provisioning',
} as const;

export const ProvisioningModel: K8sModel = {
  apiGroup: 'metal3.io',
  apiVersion: 'v1alpha1',
  kind: 'Provisioning',
  abbr: 'P',
  label: 'Provisioning',
  labelPlural: 'Provisionings',
  plural: 'provisionings',
  namespaced: false,
};

export type ProvisioningKind = K8sResourceCommon & {
  spec?: {
    watchAllNamespaces?: boolean;
  };
};

/** Exact command shown when the user cannot patch Provisioning. */
export const WATCH_ALL_NAMESPACES_OC_PATCH =
  'oc patch provisioning.metal3.io provisioning-configuration --type=merge -p \'{"spec":{"watchAllNamespaces":true}}\'';

export function isBareMetalHostsTool(tool: Pick<CommunityTool, 'metadata' | 'spec'>): boolean {
  return tool.metadata?.name === 'oct-baremetal' || tool.spec?.consolePlugin === 'oct-baremetal';
}

export function isWatchAllNamespacesEnabled(
  provisioning?: ProvisioningKind | null,
): boolean {
  return provisioning?.spec?.watchAllNamespaces === true;
}

export function k8sErrorMessage(err: unknown): string {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err.slice(0, 300);
  if (err instanceof Error) return err.message.slice(0, 300);
  const o = err as { message?: string; json?: { message?: string } };
  const msg = o.json?.message || o.message || String(err);
  return String(msg).slice(0, 300);
}

export function isNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const status =
    (err as { status?: number }).status ||
    (err as { response?: { status?: number } }).response?.status ||
    (err as { json?: { code?: number } }).json?.code;
  if (status === 404) return true;
  return /not found/i.test(k8sErrorMessage(err));
}

export function formatWatchAllNamespacesPatchError(err: unknown): string {
  return (
    `Could not set Provisioning spec.watchAllNamespaces to true (${k8sErrorMessage(err)}). ` +
    `BareMetal Operator will only reconcile hosts in ${MACHINE_API_NS}. Run: ${WATCH_ALL_NAMESPACES_OC_PATCH}`
  );
}

export const SKIP_WATCH_ALL_NAMESPACES_WARNING =
  `Bare Metal Hosts was installed without enabling watchAllNamespaces. ` +
  `Hosts outside ${MACHINE_API_NS} stay Unknown until you set spec.watchAllNamespaces: true. ` +
  `Run: ${WATCH_ALL_NAMESPACES_OC_PATCH}`;

/**
 * Patch Provisioning/provisioning-configuration with the caller's console token.
 * Does not use a plugin ServiceAccount.
 */
export async function ensureProvisioningWatchAllNamespaces(): Promise<'already' | 'patched'> {
  const existing = (await k8sGet({
    model: ProvisioningModel,
    name: PROVISIONING_NAME,
  })) as ProvisioningKind;
  if (isWatchAllNamespacesEnabled(existing)) {
    return 'already';
  }
  await k8sPatch({
    model: ProvisioningModel,
    resource: existing,
    data: [{ op: 'add', path: '/spec/watchAllNamespaces', value: true }],
  });
  return 'patched';
}
