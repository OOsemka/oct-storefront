import { loadAll, dump } from 'js-yaml';
import { k8sCreate, k8sGet, k8sPatch, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { DeploymentModel, modelForKind } from './k8s-models';

export function splitYamlDocs(raw: string): K8sResourceCommon[] {
  const docs = loadAll(raw || '');
  return docs.filter((d) => d && typeof d === 'object' && (d as K8sResourceCommon).kind) as K8sResourceCommon[];
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

export async function applyYaml(raw: string): Promise<string[]> {
  const docs = splitYamlDocs(raw);
  if (docs.length === 0) {
    throw new Error('No Kubernetes documents found in YAML.');
  }
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
        if (kind === 'Deployment' && (await patchDeploymentImage(doc))) {
          log.push(`updated ${kind}/${name}`);
        } else {
          log.push(`exists ${kind}/${name}`);
        }
      } else {
        throw e;
      }
    }
  }
  return log;
}

function desiredDeploymentImage(doc: K8sResourceCommon): string {
  const spec = (doc as { spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } } })
    .spec;
  const containers = spec?.template?.spec?.containers || [];
  const plugin = containers.find((c) => c.name === 'plugin') || containers[0];
  return plugin?.image || '';
}

/** Patch an existing plugin Deployment image (upgrade). Same ConsolePlugin name cannot run two versions. */
async function patchDeploymentImage(doc: K8sResourceCommon): Promise<boolean> {
  const name = doc.metadata?.name;
  const ns = doc.metadata?.namespace;
  const image = desiredDeploymentImage(doc);
  if (!name || !ns || !image) return false;
  try {
    const existing = (await k8sGet({ model: DeploymentModel, name, ns })) as K8sResourceCommon & {
      spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
    };
    const containers = existing.spec?.template?.spec?.containers || [];
    let idx = containers.findIndex((c) => c.name === 'plugin');
    if (idx < 0) idx = 0;
    if (!containers[idx] || containers[idx].image === image) return false;
    await k8sPatch({
      model: DeploymentModel,
      resource: existing,
      data: [{ op: 'replace', path: `/spec/template/spec/containers/${idx}/image`, value: image }],
    });
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

/** Set the plugin Deployment's container image to the selected catalog version. */
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
