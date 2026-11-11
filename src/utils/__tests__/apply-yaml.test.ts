import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: string[] = [];
const labels: Record<string, Record<string, string> | undefined> = {};
vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: vi.fn(async ({ data }: { data: { kind: string; metadata: { name: string; labels?: Record<string, string> } } }) => {
    created.push(`${data.kind}/${data.metadata.name}`);
    labels[`${data.kind}/${data.metadata.name}`] = data.metadata.labels;
    return { ...data, metadata: { ...data.metadata, uid: `uid-${data.kind}-${data.metadata.name}` } };
  }),
  k8sDelete: vi.fn(async () => ({})),
  k8sGet: vi.fn(),
  k8sPatch: vi.fn(),
  k8sUpdate: vi.fn(),
}));

import { k8sCreate, k8sDelete, k8sGet, k8sUpdate } from '@openshift-console/dynamic-plugin-sdk';
import { applyYaml, EXTENSION_LABEL, extensionLabelValue, missingNamespaces, splitYamlDocs, unsupportedKinds } from '../apply-yaml';

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

describe('applyYaml rollback', () => {
  const BUNDLE = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x }
---
apiVersion: v1
kind: Service
metadata: { name: svc, namespace: oct-x }
---
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: denied, namespace: oct-x }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: never, namespace: oct-x }
`;
  const deny = (kind: string) => {
    const real = vi.mocked(k8sCreate).getMockImplementation();
    vi.mocked(k8sCreate).mockImplementation((async (opts: { data: { kind: string; metadata: { name: string } } }) => {
      if (opts.data.kind === kind) {
        throw Object.assign(new Error(`${kind.toLowerCase()}s "denied" is forbidden: ValidatingAdmissionPolicy denied request`), {
          json: { code: 403 },
        });
      }
      return real!(opts as never);
    }) as never);
    return () => vi.mocked(k8sCreate).mockImplementation(real as never);
  };

  beforeEach(() => {
    created.length = 0;
    vi.mocked(k8sDelete).mockClear();
    vi.mocked(k8sGet).mockImplementation((async () => ({ metadata: { name: 'oct-x' } })) as never);
  });

  it('removes what this attempt created, newest first, and says so', async () => {
    const restore = deny('Route');
    try {
      await expect(applyYaml(BUNDLE)).rejects.toThrow(
        /Creating Route\/denied failed: .*forbidden.* The 2 object\(s\) this install had created were removed again\./,
      );
    } finally {
      restore();
    }
    expect(created).toEqual(['Namespace/oct-x', 'Service/svc']);
    const deleted = vi.mocked(k8sDelete).mock.calls.map((c) => `${(c[0] as { resource: { kind: string; metadata: { name: string } } }).resource.kind}/${(c[0] as { resource: { metadata: { name: string } } }).resource.metadata.name}`);
    expect(deleted).toEqual(['Service/svc', 'Namespace/oct-x']);
  });

  it('never deletes objects that already existed', async () => {
    const real = vi.mocked(k8sCreate).getMockImplementation();
    vi.mocked(k8sCreate).mockImplementation((async (opts: { data: { kind: string; metadata: { name: string } } }) => {
      if (opts.data.kind === 'Namespace') throw Object.assign(new Error('namespaces "oct-x" already exists'), { json: { code: 409 } });
      if (opts.data.kind === 'Route') throw Object.assign(new Error('forbidden'), { json: { code: 403 } });
      return real!(opts as never);
    }) as never);
    try {
      await expect(applyYaml(BUNDLE)).rejects.toThrow(/The 1 object\(s\) this install had created were removed again/);
    } finally {
      vi.mocked(k8sCreate).mockImplementation(real as never);
    }
    const deleted = vi.mocked(k8sDelete).mock.calls.map((c) => (c[0] as { resource: { kind: string } }).resource.kind);
    expect(deleted).toEqual(['Service']);
  });

  it('tells the user to wait for a removed namespace before retrying', async () => {
    const restore = deny('Route');
    try {
      await expect(applyYaml(BUNDLE)).rejects.toThrow(/Namespace oct-x takes a moment to finish deleting/);
    } finally {
      restore();
    }
  });

  it('rolls back when updating an object that already exists fails', async () => {
    const bundle = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x }
---
apiVersion: v1
kind: Service
metadata: { name: svc, namespace: oct-x }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: oct-x }
rules: [{ apiGroups: [''], resources: [pods], verbs: [get] }]
`;
    const real = vi.mocked(k8sCreate).getMockImplementation();
    vi.mocked(k8sCreate).mockImplementation((async (opts: { data: { kind: string; metadata: { name: string } } }) => {
      if (opts.data.kind === 'ClusterRole') throw Object.assign(new Error('clusterroles "oct-x" already exists'), { json: { code: 409 } });
      return real!(opts as never);
    }) as never);
    vi.mocked(k8sUpdate).mockImplementationOnce((async () => {
      throw Object.assign(new Error('update denied by admission'), { json: { code: 403 } });
    }) as never);
    try {
      await expect(applyYaml(bundle)).rejects.toThrow(/Updating the existing ClusterRole\/oct-x failed: update denied by admission The 1 object\(s\)/);
    } finally {
      vi.mocked(k8sCreate).mockImplementation(real as never);
    }
    // Kinds are applied in dependency order (ClusterRole before Service): only the Namespace existed yet.
    expect(vi.mocked(k8sDelete).mock.calls).toHaveLength(1);
  });

  it('reports objects it could not remove', async () => {
    const restore = deny('Route');
    vi.mocked(k8sDelete).mockImplementationOnce((async () => {
      throw Object.assign(new Error('forbidden'), { json: { code: 403 } });
    }) as never);
    try {
      await expect(applyYaml(BUNDLE)).rejects.toThrow(/Could not remove Service\/svc; delete them by hand before retrying\./);
    } finally {
      restore();
    }
  });
});

describe('applyYaml rollback safety (review finding: generateName)', () => {
  beforeEach(() => {
    created.length = 0;
    vi.mocked(k8sDelete).mockClear();
    vi.mocked(k8sGet).mockImplementation((async () => ({ metadata: { name: 'oct-x' } })) as never);
  });

  it('refuses bundles with generateName or no name before creating anything', async () => {
    const bundle = `
apiVersion: v1
kind: ConfigMap
metadata: { generateName: x-, namespace: openshift-config }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: broken, namespace: oct-x }
`;
    await expect(applyYaml(bundle)).rejects.toThrow(/ConfigMap \(generateName x-\) has no metadata.name .*Nothing was applied/);
    expect(created).toEqual([]);
    expect(vi.mocked(k8sDelete)).not.toHaveBeenCalled();
  });

  it('deletes the created object by name with a uid precondition', async () => {
    const real = vi.mocked(k8sCreate).getMockImplementation();
    vi.mocked(k8sCreate).mockImplementation((async (opts: { data: { kind: string; metadata: { name: string } } }) => {
      if (opts.data.kind === 'Route') throw Object.assign(new Error('forbidden'), { json: { code: 403 } });
      return real!(opts as never);
    }) as never);
    try {
      await expect(
        applyYaml(`apiVersion: v1
kind: ConfigMap
metadata: { name: cm, namespace: oct-x }
---
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: r, namespace: oct-x }
`),
      ).rejects.toThrow(/removed again/);
    } finally {
      vi.mocked(k8sCreate).mockImplementation(real as never);
    }
    const call = vi.mocked(k8sDelete).mock.calls[0][0] as unknown as {
      resource: { metadata: { name: string; uid: string } };
      json: { preconditions: { uid: string } };
    };
    expect(call.resource.metadata.name).toBe('cm');
    expect(call.json.preconditions.uid).toBe('uid-ConfigMap-cm');
  });
});

describe('generatePluginManifests hardening', () => {
  it('adds a console-only NetworkPolicy and no ServiceAccount token', async () => {
    const { generatePluginManifests } = await import('../apply-yaml');
    const docs = splitYamlDocs(generatePluginManifests({ consolePlugin: 'oct-x', image: 'quay.io/org/oct-x:1.0.0-ocp4.22', displayName: 'X' }));
    expect(docs.map((d) => d.kind)).toEqual(['Namespace', 'Deployment', 'Service', 'NetworkPolicy', 'ConsolePlugin']);
    const dep = docs[1] as unknown as { spec: { template: { spec: { automountServiceAccountToken: boolean } } } };
    expect(dep.spec.template.spec.automountServiceAccountToken).toBe(false);
    const np = docs[3] as unknown as { spec: { ingress: { ports: { port: number }[] }[] } };
    expect(np.spec.ingress[0].ports[0].port).toBe(9443);
  });
});

describe('extensionLabelValue', () => {
  it('keeps valid ids and makes external names valid label values', () => {
    expect(extensionLabelValue('oct-baremetal')).toBe('oct-baremetal');
    expect(extensionLabelValue('My Tool!')).toBe('My-Tool');
    expect(extensionLabelValue('x'.repeat(80))).toHaveLength(63);
    expect(extensionLabelValue('  !!  ')).toBe('');
  });
});
