import { loadAll, dump } from 'js-yaml';
import { k8sCreate, k8sGet, k8sPatch, k8sUpdate, K8sModel, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { DeploymentModel, modelForKind } from './k8s-models';

/** Optional PVC annotation: suggested StorageClass. Empty = cluster default. Add UI can override. Never a lab class name in YAML. */
export const PVC_STORAGE_CLASS_ANNOTATION = 'communitytools.io/storage-class';

export type PvcSummary = { name: string; size: string };

export type ApplyYamlOpts = {
  /**
   * Applied to every PersistentVolumeClaim in the bundle.
   * `undefined` leaves YAML/annotation as-is.
   * `''` omits spec.storageClassName so the cluster default StorageClass is used.
   */
  storageClassName?: string;
};

type PvcDoc = K8sResourceCommon & {
  spec?: {
    storageClassName?: string;
    accessModes?: string[];
    resources?: { requests?: { storage?: string } };
  };
};

/** Create PVCs before Deployments so pods that mount them can schedule. */
const APPLY_KIND_ORDER: Record<string, number> = {
  CustomResourceDefinition: -10,
  Namespace: 0,
  ServiceAccount: 10,
  Secret: 20,
  ConfigMap: 30,
  ClusterRole: 40,
  Role: 50,
  ClusterRoleBinding: 60,
  RoleBinding: 70,
  PersistentVolumeClaim: 80,
  Service: 90,
  Route: 100,
  Deployment: 110,
  ConsolePlugin: 120,
};

export function splitYamlDocs(raw: string): K8sResourceCommon[] {
  const docs = loadAll(raw || '');
  return docs.filter((d) => d && typeof d === 'object' && (d as K8sResourceCommon).kind) as K8sResourceCommon[];
}

export function yamlHasPersistentVolumeClaim(raw: string): boolean {
  return splitYamlDocs(raw).some((d) => d.kind === 'PersistentVolumeClaim');
}

export function pvcSummariesFromYaml(raw: string): PvcSummary[] {
  return splitYamlDocs(raw)
    .filter((d) => d.kind === 'PersistentVolumeClaim')
    .map((d) => {
      const spec = (d as PvcDoc).spec;
      return {
        name: d.metadata?.name || 'pvc',
        size: spec?.resources?.requests?.storage || '',
      };
    });
}

/** Suggested StorageClass from a PVC annotation. Empty string means cluster default. */
export function suggestedStorageClassFromYaml(raw: string): string | undefined {
  for (const d of splitYamlDocs(raw)) {
    if (d.kind !== 'PersistentVolumeClaim') continue;
    const ann = d.metadata?.annotations?.[PVC_STORAGE_CLASS_ANNOTATION];
    if (ann !== undefined) return ann;
  }
  return undefined;
}

function withPvcStorageClass(doc: K8sResourceCommon, storageClassName: string | undefined): K8sResourceCommon {
  if (doc.kind !== 'PersistentVolumeClaim') return doc;
  const pvc = doc as PvcDoc;
  const spec = { ...(pvc.spec || {}) };
  const annotated = pvc.metadata?.annotations?.[PVC_STORAGE_CLASS_ANNOTATION];
  const chosen = storageClassName !== undefined ? storageClassName : annotated;
  if (chosen === undefined) return doc;
  if (chosen === '') {
    delete spec.storageClassName;
  } else {
    spec.storageClassName = chosen;
  }
  return { ...pvc, spec } as PvcDoc;
}

function sortDocsForApply(docs: K8sResourceCommon[]): K8sResourceCommon[] {
  return [...docs].sort((a, b) => {
    const ao = APPLY_KIND_ORDER[a.kind || ''] ?? 85;
    const bo = APPLY_KIND_ORDER[b.kind || ''] ?? 85;
    if (ao !== bo) return ao - bo;
    return (a.metadata?.name || '').localeCompare(b.metadata?.name || '');
  });
}

function alreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const obj = err as { json?: { reason?: string; code?: number }; message?: string };
  return (
    obj.json?.reason === 'AlreadyExists' ||
    obj.json?.code === 409 ||
    /already exists/i.test(msg)
  );
}

export async function applyYaml(raw: string, opts: ApplyYamlOpts = {}): Promise<string[]> {
  let docs = splitYamlDocs(raw);
  if (docs.length === 0) {
    throw new Error('No Kubernetes documents found in YAML.');
  }
  docs = sortDocsForApply(docs.map((d) => withPvcStorageClass(d, opts.storageClassName)));
  const log: string[] = [];
  for (const doc of docs) {
    const kind = doc.kind || 'Unknown';
    const name = doc.metadata?.name || '(unnamed)';
    const model = modelForKind(kind);
    if (!model) {
      throw new Error(`Unsupported kind ${kind} (${name}). Include it in the storefront kind map or use a supported plugin manifest.`);
    }
    try {
      await k8sCreate({ model, data: doc });
      log.push(`created ${kind}/${name}`);
    } catch (e) {
      if (alreadyExists(e)) {
        let updated = false;
        if (kind === 'Deployment') updated = await patchDeploymentImages(doc);
        else if (CONVERGE_KINDS.has(kind)) updated = await convergeToBundle(model, doc, log);
        log.push(`${updated ? 'updated' : 'exists'} ${kind}/${name}`);
      } else {
        throw e;
      }
    }
  }
  return log;
}

/**
 * Kinds an Add/Update converges to the bundle when they already exist. An
 * upgraded controller with the previous CRD (schema, status enums) or
 * permissions is broken, so these must match the version being installed.
 * Everything else that exists keeps its cluster state: Deployments only get
 * new images (env, replicas and resources may be tuned by the admin), and
 * Services, Secrets, ConfigMaps and PVCs are never touched.
 */
const CONVERGE_KINDS = new Set([
  'CustomResourceDefinition',
  'ClusterRole',
  'Role',
  'ClusterRoleBinding',
  'RoleBinding',
  'ConsolePlugin',
]);

const NON_SPEC_KEYS = new Set(['apiVersion', 'kind', 'metadata', 'status']);

async function convergeToBundle(model: K8sModel, doc: K8sResourceCommon, log: string[]): Promise<boolean> {
  const name = doc.metadata?.name;
  const ns = doc.metadata?.namespace;
  if (!name) return false;
  const existing = (await k8sGet({ model, name, ns })) as Record<string, unknown> & K8sResourceCommon;
  const want = doc as Record<string, unknown>;
  // roleRef is immutable; a changed one needs delete + create, which is not
  // something to do silently during an upgrade.
  if (want.roleRef && JSON.stringify(want.roleRef) !== JSON.stringify(existing.roleRef)) {
    log.push(`skipped ${doc.kind}/${name}: roleRef differs from the installed one`);
    return false;
  }
  const next: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const key of Object.keys(want)) {
    if (NON_SPEC_KEYS.has(key)) continue;
    if (JSON.stringify(want[key]) !== JSON.stringify(existing[key])) {
      next[key] = want[key];
      changed = true;
    }
  }
  const labels = { ...(existing.metadata?.labels || {}), ...(doc.metadata?.labels || {}) };
  if (JSON.stringify(labels) !== JSON.stringify(existing.metadata?.labels || {})) {
    next.metadata = { ...existing.metadata, labels };
    changed = true;
  }
  if (!changed) return false;
  await k8sUpdate({ model, data: next as K8sResourceCommon, name, ns });
  return true;
}

type EnvVar = { name?: string; value?: string; valueFrom?: unknown };
type ContainerList = Array<{ name?: string; image?: string; env?: EnvVar[] }>;

function deploymentContainers(doc: K8sResourceCommon): ContainerList {
  const spec = (doc as { spec?: { template?: { spec?: { containers?: ContainerList } } } }).spec;
  return spec?.template?.spec?.containers || [];
}

type JsonPatchOp = { op: string; path: string; value: unknown };

/**
 * JSON-patch ops that upgrade the running containers to the bundle: each
 * container (matched by name) gets the bundle's image, plus any env var the
 * bundle defines that the container does not have yet. A new release can
 * need a new setting (Shift-on-Shift 0.2.0 needs DNS_MODE); without this an
 * upgraded Deployment runs the new image with the old configuration.
 * Existing env vars are never changed or removed: the admin may have tuned them.
 */
export function deploymentUpgradeOps(current: ContainerList, wanted: ContainerList): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  current.forEach((c, idx) => {
    const w = wanted.find((x) => x.name === c.name) || (current.length === 1 && wanted.length === 1 ? wanted[0] : undefined);
    if (!w) return;
    const base = `/spec/template/spec/containers/${idx}`;
    if (w.image && w.image !== c.image) {
      ops.push({ op: 'replace', path: `${base}/image`, value: w.image });
    }
    const have = new Set((c.env || []).map((e) => e.name));
    const missing = (w.env || []).filter((e) => e.name && !have.has(e.name));
    if (missing.length === 0) return;
    if (!c.env) {
      ops.push({ op: 'add', path: `${base}/env`, value: missing });
    } else {
      for (const e of missing) ops.push({ op: 'add', path: `${base}/env/-`, value: e });
    }
  });
  return ops;
}

/**
 * Upgrade an existing Deployment (see deploymentUpgradeOps). Covers companion
 * Deployments such as an orchestrator, not just the plugin. Same ConsolePlugin
 * name cannot run two versions.
 */
async function patchDeploymentImages(doc: K8sResourceCommon): Promise<boolean> {
  const name = doc.metadata?.name;
  const ns = doc.metadata?.namespace;
  const wanted = deploymentContainers(doc);
  if (!name || !ns || wanted.length === 0) return false;
  try {
    const existing = (await k8sGet({ model: DeploymentModel, name, ns })) as K8sResourceCommon;
    const ops = deploymentUpgradeOps(deploymentContainers(existing), wanted);
    if (ops.length === 0) return false;
    await k8sPatch({ model: DeploymentModel, resource: existing, data: ops });
    return true;
  } catch {
    return false;
  }
}

export function generatePluginManifests(opts: {
  consolePlugin: string;
  image: string;
  displayName: string;
  version?: string;
}): string {
  const name = opts.consolePlugin;
  const ns = name;
  const versionLabel = opts.version
    ? `\n    communitytools.io/extension-version: ${JSON.stringify(opts.version)}`
    : '';
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    app.kubernetes.io/part-of: ${name}
    app.kubernetes.io/managed-by: oct-storefront
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    app.kubernetes.io/part-of: ${name}${versionLabel}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: plugin
          image: ${opts.image}
          ports:
            - containerPort: 9443
              protocol: TCP
          volumeMounts:
            - name: plugin-serving-cert
              readOnly: true
              mountPath: /var/serving-cert
          resources:
            requests:
              cpu: 10m
              memory: 50Mi
            limits:
              cpu: 100m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            seccompProfile:
              type: RuntimeDefault
            capabilities:
              drop:
                - ALL
      volumes:
        - name: plugin-serving-cert
          secret:
            secretName: plugin-serving-cert
            defaultMode: 420
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    app.kubernetes.io/part-of: ${name}
  annotations:
    service.beta.openshift.io/serving-cert-secret-name: plugin-serving-cert
spec:
  ports:
    - name: 9443-tcp
      protocol: TCP
      port: 9443
      targetPort: 9443
  selector:
    app: ${name}
---
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata:
  name: ${name}
spec:
  displayName: ${JSON.stringify(opts.displayName)}
  backend:
    type: Service
    service:
      name: ${name}
      namespace: ${ns}
      port: 9443
      basePath: /
`;
}

/** Set the plugin Deployment's container image to the selected catalog version (combined tag). */
export function applyVersionImage(yaml: string, pluginName: string, image?: string): string {
  if (!image) return yaml;
  const docs = loadAll(yaml || '');
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const d = doc as Record<string, unknown>;
    if (d.kind !== 'Deployment') continue;
    const meta = d.metadata as Record<string, unknown> | undefined;
    if (meta?.name !== pluginName) continue;
    const spec = d.spec as Record<string, unknown> | undefined;
    const template = spec?.template as Record<string, unknown> | undefined;
    const podSpec = template?.spec as Record<string, unknown> | undefined;
    const containers = podSpec?.containers as Array<Record<string, unknown>> | undefined;
    if (!containers) continue;
    for (const c of containers) {
      if (c.name === 'plugin' || containers.length === 1) {
        c.image = image;
      }
    }
  }
  return docs
    .filter(Boolean)
    .map((d) => dump(d, { lineWidth: 120, noRefs: true }))
    .join('---\n');
}
