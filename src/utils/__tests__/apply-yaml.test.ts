import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: string[] = [];
vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: vi.fn(async ({ data }: { data: { kind: string; metadata: { name: string } } }) => {
    created.push(`${data.kind}/${data.metadata.name}`);
    return data;
  }),
  k8sGet: vi.fn(),
  k8sPatch: vi.fn(),
  k8sUpdate: vi.fn(),
}));

import { applyYaml, splitYamlDocs, unsupportedKinds } from '../apply-yaml';

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
