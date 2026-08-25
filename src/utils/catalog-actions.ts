import {
  k8sCreate,
  k8sGet,
  k8sPatch,
  K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
import bundledCommunityYaml from '../../catalog/community.yaml';
import bmhDeployYaml from '../../catalog/deploy/oct-baremetal.yaml';
import bondDeployYaml from '../../catalog/deploy/oct-network-bond.yaml';
import { ConfigMapModel, ConsoleOperatorModel } from './k8s-models';
import {
  CACHE_CONFIGMAP,
  CommunityTool,
  DEFAULT_CHANNEL,
  emptyStats,
  EXTERNAL_CONFIGMAP,
  ExtensionStats,
  InstalledMap,
  InstalledRecord,
  StatsMap,
  STOREFRONT_NS,
  SyncStatus,
  ToolVersion,
  imageForRow,
} from './catalog-types';
import {
  mergePublicIntoTool,
  parseToolList,
  toCommunityYaml,
  toolFromPublic,
} from './parse-tools';
import { applyYaml, applyVersionImage, generatePluginManifests } from './apply-yaml';
import { fetchDeployYaml, fetchPublicCatalog, postPublicDownload, postPublicRating } from './public-catalog';

const BUNDLED_DEPLOY: Record<string, string> = {
  'oct-baremetal': bmhDeployYaml,
  'oct-network-bond': bondDeployYaml,
};

type ConfigMapKind = K8sResourceCommon & { data?: Record<string, string> };
type ConsoleKind = K8sResourceCommon & { spec?: { plugins?: string[] } };

function parseStats(raw?: string): StatsMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as StatsMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseSync(raw?: string): SyncStatus {
  if (!raw) return { ok: false, source: 'bundled' };
  try {
    return JSON.parse(raw) as SyncStatus;
  } catch {
    return { ok: false, source: 'bundled' };
  }
}

export function bundledCommunityTools(): CommunityTool[] {
  return parseToolList(bundledCommunityYaml, 'community');
}

export function toolsFromCache(cm?: ConfigMapKind): CommunityTool[] {
  const yaml = cm?.data?.['community.yaml'];
  if (!yaml) return bundledCommunityTools();
  const parsed = parseToolList(yaml, 'community');
  return parsed.length ? parsed : bundledCommunityTools();
}

export function externalToolsFromCache(cm?: ConfigMapKind): CommunityTool[] {
  return parseToolList(cm?.data?.['tools.yaml'] || '', 'external').map((t) => ({
    ...t,
    spec: { ...t.spec, source: 'external' as const },
  }));
}

export function statsFromCache(cm?: ConfigMapKind): StatsMap {
  return parseStats(cm?.data?.['stats.json']);
}

export function syncFromCache(cm?: ConfigMapKind): SyncStatus {
  return parseSync(cm?.data?.['sync.json']);
}

export function installedFromCache(cm?: ConfigMapKind): InstalledMap {
  const raw = cm?.data?.['installed.json'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as InstalledMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function recordInstalled(id: string, rec: InstalledRecord): Promise<void> {
  const cm = await getConfigMap(CACHE_CONFIGMAP);
  const map = installedFromCache(cm || undefined);
  map[id] = rec;
  await writeConfigMap(CACHE_CONFIGMAP, { 'installed.json': JSON.stringify(map) });
}

async function getConfigMap(name: string): Promise<ConfigMapKind | null> {
  try {
    return (await k8sGet({ model: ConfigMapModel, name, ns: STOREFRONT_NS })) as ConfigMapKind;
  } catch {
    return null;
  }
}

async function writeConfigMap(name: string, data: Record<string, string>): Promise<void> {
  const existing = await getConfigMap(name);
  if (!existing) {
    await k8sCreate({
      model: ConfigMapModel,
      data: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name,
          namespace: STOREFRONT_NS,
          labels: { 'app.kubernetes.io/part-of': 'oct-storefront' },
        },
        data,
      },
    });
    return;
  }
  if (!existing.data) {
    await k8sPatch({
      model: ConfigMapModel,
      resource: existing,
      data: [{ op: 'add', path: '/data', value: data }],
    });
    return;
  }
  const patches = Object.keys(data).map((key) => ({
    op: existing.data?.[key] === undefined ? 'add' : 'replace',
    path: `/data/${key.replace(/\//g, '~1')}`,
    value: data[key],
  }));
  await k8sPatch({ model: ConfigMapModel, resource: existing, data: patches });
}

export async function ensureCacheSeeded(): Promise<void> {
  const existing = await getConfigMap(CACHE_CONFIGMAP);
  if (existing?.data?.['community.yaml']) return;
  await writeConfigMap(CACHE_CONFIGMAP, {
    'community.yaml': bundledCommunityYaml,
    'stats.json': '{}',
    'sync.json': JSON.stringify({
      ok: false,
      source: 'bundled',
      checkedAt: new Date().toISOString(),
      message: 'Seeded from the plugin bundle.',
    } as SyncStatus),
  });
}

export async function refreshPublicCatalogIntoCache(): Promise<SyncStatus> {
  const result = await fetchPublicCatalog();
  const checkedAt = new Date().toISOString();
  if (!result.ok || !result.catalog) {
    const status: SyncStatus = {
      ok: false,
      source: 'cache',
      checkedAt,
      message: result.reason || 'Public catalog unreachable.',
    };
    try {
      await writeConfigMap(CACHE_CONFIGMAP, { 'sync.json': JSON.stringify(status) });
    } catch {
      /* fail-open */
    }
    return status;
  }

  const byId = new Map(bundledCommunityTools().map((t) => [t.metadata.name, t]));
  for (const ext of result.catalog.extensions || []) {
    const id = ext.id || ext.consolePlugin;
    if (!id) continue;
    const existing = byId.get(id);
    const next = existing ? mergePublicIntoTool(existing, ext) : toolFromPublic(ext);
    if (next) byId.set(id, next);
  }

  const current = statsFromCache((await getConfigMap(CACHE_CONFIGMAP)) || undefined);
  for (const ext of result.catalog.extensions || []) {
    const id = ext.id || ext.consolePlugin;
    if (!id) continue;
    const prev = current[id] || emptyStats();
    current[id] = {
      ...prev,
      publicDownloads: ext.downloads,
      publicRatingAverage: ext.rating?.average,
      publicRatingCount: ext.rating?.count,
    };
  }

  const status: SyncStatus = {
    ok: true,
    source: 'public',
    checkedAt,
    message: result.catalog.generatedAt
      ? `Public catalog generatedAt ${result.catalog.generatedAt}`
      : 'Synced from public catalog.',
  };

  await writeConfigMap(CACHE_CONFIGMAP, {
    'community.yaml': toCommunityYaml(Array.from(byId.values())),
    'stats.json': JSON.stringify(current),
    'sync.json': JSON.stringify(status),
  });
  return status;
}

async function patchStats(mutator: (stats: StatsMap) => void): Promise<void> {
  const cm = await getConfigMap(CACHE_CONFIGMAP);
  const stats = statsFromCache(cm || undefined);
  mutator(stats);
  await writeConfigMap(CACHE_CONFIGMAP, { 'stats.json': JSON.stringify(stats) });
}

export async function incrementDownloads(
  id: string,
  source: 'community' | 'external',
): Promise<void> {
  await patchStats((stats) => {
    const cur = stats[id] || emptyStats();
    cur.downloads = (cur.downloads || 0) + 1;
    stats[id] = cur;
  });
  if (source === 'community') {
    void postPublicDownload(id);
  }
}

export async function setClusterRating(
  id: string,
  rating: number,
  source: 'community' | 'external',
): Promise<void> {
  const stars = Math.min(5, Math.max(1, Math.round(rating)));
  await patchStats((stats) => {
    const cur = stats[id] || emptyStats();
    if (cur.clusterRating) {
      cur.ratingSum = Math.max(0, (cur.ratingSum || 0) - cur.clusterRating + stars);
    } else {
      cur.ratingSum = (cur.ratingSum || 0) + stars;
      cur.ratingCount = (cur.ratingCount || 0) + 1;
    }
    cur.clusterRating = stars;
    stats[id] = cur;
  });
  if (source === 'community') {
    void postPublicRating(id, stars);
  }
}

export async function saveExternalTool(tool: CommunityTool): Promise<void> {
  const nextTool: CommunityTool = {
    ...tool,
    spec: { ...tool.spec, source: 'external' },
  };
  const cm = await getConfigMap(EXTERNAL_CONFIGMAP);
  const existing = externalToolsFromCache(cm || undefined);
  const next = [...existing.filter((t) => t.metadata.name !== nextTool.metadata.name), nextTool];
  await writeConfigMap(EXTERNAL_CONFIGMAP, { 'tools.yaml': toCommunityYaml(next) });
}

export async function setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
  const cons = (await k8sGet({
    model: ConsoleOperatorModel,
    name: 'cluster',
  })) as ConsoleKind;
  const current = cons.spec?.plugins || [];
  const next = enabled
    ? Array.from(new Set([...current, pluginName]))
    : current.filter((p) => p !== pluginName);
  await k8sPatch({
    model: ConsoleOperatorModel,
    resource: cons,
    data: [
      {
        op: Array.isArray(cons.spec?.plugins) ? 'replace' : 'add',
        path: '/spec/plugins',
        value: next,
      },
    ],
  });
}

export async function resolveDeployYaml(
  tool: CommunityTool,
  version?: ToolVersion,
  clusterMinor?: string,
): Promise<string> {
  const image = imageForRow(version, clusterMinor, tool.spec.image);
  const deployYAML = version?.deployYAML || tool.spec.deployYAML;
  const deployURL = version?.deployURL || tool.spec.deployURL;
  let yaml = '';
  if (deployYAML?.trim()) yaml = deployYAML;
  else {
    const bundled = BUNDLED_DEPLOY[tool.metadata.name] || BUNDLED_DEPLOY[tool.spec.consolePlugin];
    if (bundled) yaml = bundled;
  }
  if (!yaml && deployURL) {
    const fetched = await fetchDeployYaml(deployURL);
    if (fetched.ok && fetched.yaml) yaml = fetched.yaml;
    else throw new Error(fetched.reason || `Could not fetch deploy YAML from ${deployURL}`);
  }
  if (!yaml && image) {
    yaml = generatePluginManifests({
      consolePlugin: tool.spec.consolePlugin,
      image,
      displayName: tool.spec.displayName,
      version: version?.version,
    });
  }
  if (!yaml) {
    throw new Error('This extension has no deployYAML, deployURL, or image for the selected OpenShift version.');
  }
  return applyVersionImage(yaml, tool.spec.consolePlugin, image);
}

/** Bundled or spec.deployYAML without fetching deployURL. Used to detect PVCs before Add. */
export function peekDeployYaml(tool: CommunityTool, version?: ToolVersion): string {
  const fromVersion = version?.deployYAML?.trim();
  if (fromVersion) return fromVersion;
  const fromSpec = tool.spec.deployYAML?.trim();
  if (fromSpec) return fromSpec;
  return BUNDLED_DEPLOY[tool.metadata.name] || BUNDLED_DEPLOY[tool.spec.consolePlugin] || '';
}

export type AddExtensionOpts = {
  storageClassName?: string;
};

export async function addExtension(
  tool: CommunityTool,
  version?: ToolVersion,
  clusterMinor?: string,
  opts: AddExtensionOpts = {},
): Promise<string[]> {
  const image = imageForRow(version, clusterMinor, tool.spec.image);
  const yaml = await resolveDeployYaml(tool, version, clusterMinor);
  const storageClassName =
    opts.storageClassName !== undefined ? opts.storageClassName : tool.spec.storageClassName;
  const log = await applyYaml(yaml, { storageClassName });
  await setPluginEnabled(tool.spec.consolePlugin, true);
  await incrementDownloads(tool.metadata.name, tool.spec.source);
  await recordInstalled(tool.metadata.name, {
    version: version?.version || '',
    channel: version?.channel || tool.spec.defaultChannel || DEFAULT_CHANNEL,
    image,
  });
  return log;
}

/** Re-enable without changing the running image (no auto-upgrade). */
export async function enableExtension(tool: CommunityTool): Promise<void> {
  await setPluginEnabled(tool.spec.consolePlugin, true);
}

/** Default Remove: disable this ConsolePlugin only (leave Deployment; do not touch other tools). */
export async function removeExtension(tool: CommunityTool): Promise<void> {
  await setPluginEnabled(tool.spec.consolePlugin, false);
}

export function statsFor(id: string, stats: StatsMap): ExtensionStats {
  return stats[id] || emptyStats();
}
