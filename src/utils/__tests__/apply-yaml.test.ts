import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: string[] = [];
const labels: Record<string, Record<string, string> | undefined> = {};
vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: vi.fn(async ({ data }: { data: { kind: string; metadata: { name: string; labels?: Record<string, string> } } }) => {
    created.push(`${data.kind}/${data.metadata.name}`);
    labels[`${data.kind}/${data.metadata.name}`] = data.metadata.labels;
    return data;
  }),
  k8sGet: vi.fn(),
  k8sPatch: vi.fn(),
  k8sUpdate: vi.fn(),
}));

import { k8sGet } from '@openshift-console/dynamic-plugin-sdk';
import { applyYaml, EXTENSION_LABEL, missingNamespaces, splitYamlDocs, unsupportedKinds } from '../apply-yaml';

const GOOD = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cm, namespace: oct-x }
`;
const WITH_UNKNOWN = `${GOOD}
---
apiVersion: networking.example.io/v1
kind: SomethingNew
metadata: { name: thing, namespace: oct-x }
`;

describe('applyYaml kind preflight', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('lists kinds the storefront cannot apply', () => {
    expect(unsupportedKinds(splitYamlDocs(WITH_UNKNOWN))).toEqual(['SomethingNew (thing)']);
    expect(unsupportedKinds(splitYamlDocs(GOOD))).toEqual([]);
  });

  it('applies nothing when any document has an unsupported kind', async () => {
    await expect(applyYaml(WITH_UNKNOWN)).rejects.toThrow(/Unsupported kind SomethingNew \(thing\)\. Nothing was applied/);
    expect(created).toEqual([]);
  });

  it('still applies supported bundles in kind order', async () => {
    const log = await applyYaml(GOOD);
    expect(created).toEqual(['Namespace/oct-x', 'ConfigMap/cm']);
    expect(log).toEqual(['created Namespace/oct-x', 'created ConfigMap/cm']);
  });
});

describe('applyYaml extension label and NetworkPolicy', () => {
  beforeEach(() => {
    created.length = 0;
  });

  const WITH_NP = `${GOOD}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: console-only, namespace: oct-x, labels: { keep: me } }
spec: { podSelector: {} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: oct-x, namespace: oct-x }
spec: { template: { spec: { containers: [{ name: p, image: quay.io/x/y:1.0.0 }] } } }
`;

  it('applies NetworkPolicy before Deployments', async () => {
    await applyYaml(WITH_NP);
    expect(created).toEqual(['Namespace/oct-x', 'ConfigMap/cm', 'NetworkPolicy/console-only', 'Deployment/oct-x']);
  });

  it('labels created objects with the extension id, but never a Namespace', async () => {
    await applyYaml(WITH_NP, { extensionId: 'oct-x' });
    expect(labels['ConfigMap/cm']?.[EXTENSION_LABEL]).toBe('oct-x');
    expect(labels['NetworkPolicy/console-only']).toEqual({ keep: 'me', [EXTENSION_LABEL]: 'oct-x' });
    expect(labels['Namespace/oct-x']?.[EXTENSION_LABEL]).toBeUndefined();
  });

  it('adds no label without an extension id', async () => {
    await applyYaml(GOOD);
    expect(labels['ConfigMap/cm']).toBeUndefined();
  });
});

describe('namespace preflight', () => {
  const ELSEWHERE = `${GOOD}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: bench, namespace: openshift-storage }
rules: []
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: cluster-wide }
rules: []
`;

  it('lists namespaces the bundle needs but neither creates nor finds', async () => {
    const exists = async (ns: string) => ns !== 'openshift-storage';
    expect(await missingNamespaces(splitYamlDocs(ELSEWHERE), exists)).toEqual(['openshift-storage']);
    expect(await missingNamespaces(splitYamlDocs(GOOD), async () => false)).toEqual([]); // oct-x is created by the bundle
  });

  it('applies nothing when a needed namespace is missing', async () => {
    created.length = 0;
    vi.mocked(k8sGet).mockImplementation((async ({ name }: { name: string }) => {
      if (name === 'openshift-storage') throw Object.assign(new Error('not found'), { json: { code: 404 } });
      return {};
    }) as never);
    await expect(applyYaml(ELSEWHERE)).rejects.toThrow(/Namespace openshift-storage does not exist.*Nothing was applied/);
    expect(created).toEqual([]);
    vi.mocked(k8sGet).mockReset();
  });

  it('does not block on errors other than not found (e.g. forbidden)', async () => {
    const exists = async () => true;
    expect(await missingNamespaces(splitYamlDocs(ELSEWHERE), exists)).toEqual([]);
  });
});
