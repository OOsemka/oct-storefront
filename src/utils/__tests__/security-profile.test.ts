import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { deriveProfile, findingKeys, rbacDiff, imageRegistry } from '../security-profile';

const PLUGIN = `
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
      containers:
        - name: plugin
          image: quay.io/org/oct-x:1.0.0-ocp4.22
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true }
---
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata: { name: oct-x }
spec: { backend: { type: Service, service: { name: oct-x, namespace: oct-x, port: 9443 } } }
`;

const clusterRole = (name: string, rules: string) => `
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: ${name} }
rules:
${rules}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: ${name} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ${name} }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]
`;

describe('deriveProfile levels', () => {
  it('plugin-only bundle is level plugin with no findings', () => {
    const p = deriveProfile(PLUGIN);
    expect(p.level).toBe('plugin');
    expect(p.findings).toEqual([]);
    expect(p.images).toEqual([{ ref: 'quay.io/org/oct-x:1.0.0-ocp4.22', registry: 'quay.io', digest: false, workload: 'Deployment/oct-x' }]);
  });

  it('namespaced: ServiceAccount + Role in its own namespace', () => {
    const p = deriveProfile(`${PLUGIN}
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: sa, namespace: oct-x }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: r, namespace: oct-x }
rules: [{ apiGroups: [""], resources: [configmaps], verbs: [get, update] }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: r, namespace: oct-x }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: r }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]
`);
    expect(p.level).toBe('namespaced');
    expect(p.namespacedRules).toHaveLength(1);
    expect(p.clusterRules).toHaveLength(0);
  });

  it('cluster-read: read-only ClusterRole bound cluster-wide', () => {
    const p = deriveProfile(PLUGIN + clusterRole('reader', '  - { apiGroups: [kubevirt.io], resources: [virtualmachines], verbs: [get, list, watch] }'));
    expect(p.level).toBe('cluster-read');
  });

  it('cluster-write: write verbs cluster-wide', () => {
    const p = deriveProfile(PLUGIN + clusterRole('writer', '  - { apiGroups: [kubevirt.io], resources: [virtualmachines], verbs: [create, delete] }'));
    expect(p.level).toBe('cluster-write');
  });

  it('privileged: cluster-wide secret read, pods/exec, SCC use, RBAC write', () => {
    const p = deriveProfile(
      PLUGIN +
        clusterRole(
          'big',
          [
            '  - { apiGroups: [""], resources: [secrets], verbs: [get, list] }',
            '  - { apiGroups: [""], resources: [pods/exec], verbs: [create] }',
            '  - { apiGroups: [security.openshift.io], resources: [securitycontextconstraints], resourceNames: [anyuid], verbs: [use] }',
            '  - { apiGroups: [rbac.authorization.k8s.io], resources: [clusterrolebindings], verbs: [create, delete] }',
          ].join('\n'),
        ),
    );
    expect(p.level).toBe('privileged');
    const ids = p.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['rbac-cluster-secrets-read', 'rbac-cluster-pods-exec', 'scc-use', 'rbac-cluster-rbac-write']));
  });

  it('secret read limited by resourceNames is not cluster-wide secret read', () => {
    const p = deriveProfile(PLUGIN + clusterRole('one', '  - { apiGroups: [""], resources: [secrets], resourceNames: [one], verbs: [get] }'));
    expect(p.findings.map((f) => f.id)).not.toContain('rbac-cluster-secrets-read');
    expect(p.level).toBe('cluster-read');
  });

  it('a ClusterRole bound only by a RoleBinding is namespaced', () => {
    const p = deriveProfile(`${PLUGIN}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: cr }
rules: [{ apiGroups: [""], resources: [secrets], verbs: [get, list] }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: cr, namespace: oct-x }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cr }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]
`);
    expect(p.level).toBe('namespaced');
    expect(p.findings.map((f) => f.id)).not.toContain('rbac-cluster-secrets-read');
  });

  it('binding cluster-admin cluster-wide is privileged', () => {
    const p = deriveProfile(`${PLUGIN}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: x }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]
`);
    expect(p.level).toBe('privileged');
    expect(p.findings.map((f) => f.id)).toContain('rbac-binds-cluster-admin');
  });

  it('host access and capabilities are privileged', () => {
    const p = deriveProfile(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: d, namespace: oct-x }
spec:
  template:
    spec:
      hostNetwork: true
      volumes: [{ name: h, hostPath: { path: /var/run } }]
      containers:
        - name: c
          image: quay.io/org/c:1.0.0
          securityContext: { capabilities: { add: [NET_ADMIN] } }
`);
    expect(p.level).toBe('privileged');
    expect(p.hostAccess.length).toBe(3);
  });

  it('flags plain-HTTP Routes, proxies without UserToken, missing NetworkPolicy and Secrets with data', () => {
    const p = deriveProfile(`
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: r, namespace: oct-x }
spec: { to: { kind: Service, name: svc } }
---
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata: { name: oct-x }
spec:
  proxy:
    - { alias: api, endpoint: { type: Service, service: { name: svc, namespace: oct-x, port: 8443 } } }
---
apiVersion: v1
kind: Secret
metadata: { name: s, namespace: oct-x }
stringData: { password: x }
`);
    const ids = p.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['route-exposed-plain-http', 'proxy-no-user-token', 'backend-no-networkpolicy', 'secret-with-data']));
    expect(p.proxies[0]).toMatchObject({ alias: 'api', authorization: 'None' });
  });

  it('invalid YAML yields an empty plugin-level profile instead of throwing', () => {
    expect(deriveProfile(': : :\n  - [').level).toBe('plugin');
  });
});

describe('helpers', () => {
  it('imageRegistry', () => {
    expect(imageRegistry('quay.io/a/b:1')).toBe('quay.io');
    expect(imageRegistry('nginx:1.27')).toBe('docker.io');
    expect(imageRegistry('library/nginx')).toBe('docker.io');
    expect(imageRegistry('localhost/x:1')).toBe('localhost');
    expect(imageRegistry('image-registry.openshift-image-registry.svc:5000/ns/x')).toBe('image-registry.openshift-image-registry.svc:5000');
  });

  it('rbacDiff reports added and removed rules per role', () => {
    const before = clusterRole('r', '  - { apiGroups: [""], resources: [configmaps], verbs: [get] }');
    const after = clusterRole('r', '  - { apiGroups: [""], resources: [configmaps, secrets], verbs: [get] }');
    expect(rbacDiff(before, after)).toEqual([{ role: 'ClusterRole/r', added: ['core/secrets get'], removed: [] }]);
    expect(rbacDiff(after, after)).toEqual([]);
  });
});

describe('catalog deploy bundles', () => {
  const dir = join(__dirname, '..', '..', '..', 'catalog', 'deploy');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();

  it('derives a profile for every bundle (levels snapshot)', () => {
    const levels = Object.fromEntries(files.map((f) => [f, deriveProfile(readFileSync(join(dir, f), 'utf8')).level]));
    expect(levels).toMatchSnapshot();
  });

  it('finding keys are stable and sorted', () => {
    for (const f of files) {
      const keys = findingKeys(deriveProfile(readFileSync(join(dir, f), 'utf8')));
      expect([...keys].sort()).toEqual(keys);
    }
  });
});

describe('review findings 2026-11-10: privilege derivation gaps', () => {
  const ids = (yaml: string) => deriveProfile(yaml).findings.map((f) => f.id);
  const lvl = (yaml: string) => deriveProfile(yaml).level;
  const crb = (role: string) => `
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: ${role} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ${role} }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]`;
  const clusterRole = (name: string, rules: string) => `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: ${name} }
rules: ${rules}${crb(name)}`;

  it('flags writing the storefront policy or admission settings as privileged', () => {
    const y = `
apiVersion: v1
kind: ConfigMap
metadata: { name: community-tools-policy, namespace: oct-storefront }
data: { policy.yaml: "mode: off" }`;
    expect(ids(y)).toContain('object-in-storefront-namespace');
    expect(lvl(y)).toBe('privileged');
  });

  it('flags objects in platform namespaces and in namespaces the bundle does not create', () => {
    const plat = `
apiVersion: v1
kind: ConfigMap
metadata: { name: user-ca-bundle, namespace: openshift-config }`;
    expect(ids(plat)).toContain('object-in-platform-namespace');
    expect(lvl(plat)).toBe('privileged');
    const foreign = `
apiVersion: v1
kind: ConfigMap
metadata: { name: cm, namespace: someone-else }`;
    expect(ids(foreign)).toContain('object-outside-own-namespace');
    expect(lvl(foreign)).toBe('cluster-write');
    const own = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cm, namespace: oct-x }`;
    expect(lvl(own)).toBe('plugin');
  });

  it('flags namespaces that skip pod security', () => {
    const y = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x, labels: { openshift.io/run-level: "0" } }`;
    expect(ids(y)).toContain('namespace-privileged');
    expect(lvl(y)).toBe('privileged');
  });

  it('treats aggregationRule and aggregate-to labels as privileged', () => {
    const agg = `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: agg }
aggregationRule: { clusterRoleSelectors: [{ matchLabels: { rbac.authorization.k8s.io/aggregate-to-admin: "true" } }] }
rules: []${crb('agg')}`;
    expect(ids(agg)).toContain('rbac-aggregation-rule');
    expect(lvl(agg)).toBe('privileged');
    const into = `
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: into, labels: { rbac.authorization.k8s.io/aggregate-to-edit: "true" } }
rules: [{ apiGroups: [""], resources: [configmaps], verbs: [create] }]`;
    expect(ids(into)).toContain('rbac-aggregates-into-builtin');
    expect(lvl(into)).toBe('privileged');
  });

  it('judges RBAC in platform namespaces like cluster-wide RBAC', () => {
    const y = `
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: r, namespace: openshift-config }
rules: [{ apiGroups: [""], resources: [secrets], verbs: [get] }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: r, namespace: openshift-config }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: r }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]`;
    const p = deriveProfile(y);
    expect(p.findings.find((f) => f.id === 'rbac-cluster-secrets-read')?.object).toBe('Role/r');
    expect(p.level).toBe('privileged');
    const adminInKubeSystem = `
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: b, namespace: kube-system }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: admin }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]`;
    expect(lvl(adminInKubeSystem)).toBe('privileged');
  });

  it.each([
    ['pods/* exec', '[{ apiGroups: [""], resources: ["*/exec"], verbs: [create] }]', 'rbac-cluster-pods-exec'],
    ['serviceaccount tokens', '[{ apiGroups: [""], resources: [serviceaccounts/token], verbs: [create] }]', 'rbac-cluster-sa-token'],
    ['SCC update', '[{ apiGroups: [security.openshift.io], resources: [securitycontextconstraints], verbs: [patch] }]', 'rbac-scc-write'],
    ['webhooks', '[{ apiGroups: [admissionregistration.k8s.io], resources: [mutatingwebhookconfigurations], verbs: [create] }]', 'rbac-cluster-admission-write'],
    ['VAP binding delete', '[{ apiGroups: [admissionregistration.k8s.io], resources: [validatingadmissionpolicybindings], verbs: [delete] }]', 'rbac-cluster-admission-write'],
    ['PV create', '[{ apiGroups: [""], resources: [persistentvolumes], verbs: [create] }]', 'rbac-cluster-pv-create'],
    ['workload patch', '[{ apiGroups: [apps], resources: [daemonsets], verbs: [patch] }]', 'rbac-cluster-workload-create'],
    ['ephemeral containers', '[{ apiGroups: [""], resources: [pods/ephemeralcontainers], verbs: [patch] }]', 'rbac-cluster-workload-create'],
    ['node proxy', '[{ apiGroups: [""], resources: [nodes/proxy], verbs: [get] }]', 'rbac-cluster-nodes-proxy'],
    ['groups', '[{ apiGroups: [user.openshift.io], resources: [groups], verbs: [update] }]', 'rbac-cluster-identity-write'],
    ['CSR approval', '[{ apiGroups: [certificates.k8s.io], resources: [certificatesigningrequests/approval], verbs: [update] }]', 'rbac-cluster-csr-approve'],
  ])('rates %s as privileged', (_name, rules, id) => {
    const y = clusterRole('r', rules);
    expect(ids(y)).toContain(id);
    expect(lvl(y)).toBe('privileged');
  });

  it('shows new or changed bindings in the update diff', () => {
    const prev = clusterRole('r', '[{ apiGroups: [""], resources: [configmaps], verbs: [get] }]');
    const next = `${prev}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: extra }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: sa, namespace: oct-x }]`;
    const diff = rbacDiff(prev, next);
    expect(diff).toEqual([
      { role: 'ClusterRoleBinding/extra', added: ['grants ClusterRole cluster-admin', 'to ServiceAccount oct-x/sa'], removed: [] },
    ]);
  });
});

describe('own-namespace exemptions cannot be claimed', () => {
  const withNs = (ns: string) => `
apiVersion: v1
kind: Namespace
metadata: { name: ${ns} }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: community-tools-policy, namespace: ${ns} }`;
  it('a Namespace document for oct-storefront or a platform namespace does not exempt the bundle', () => {
    expect(deriveProfile(withNs('oct-storefront')).findings.map((f) => f.id)).toContain('object-in-storefront-namespace');
    expect(deriveProfile(withNs('openshift-config')).findings.map((f) => f.id)).toContain('object-in-platform-namespace');
    expect(deriveProfile(withNs('oct-storefront')).level).toBe('privileged');
  });
  it('only the explicit option lets the storefront own its namespace', () => {
    expect(deriveProfile(withNs('oct-storefront'), { ownsStorefrontNamespace: true }).level).toBe('plugin');
    expect(deriveProfile(withNs('openshift-config'), { ownsStorefrontNamespace: true }).level).toBe('privileged');
  });
});
