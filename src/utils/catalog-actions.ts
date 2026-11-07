import {
  k8sCreate,
  k8sGet,
  k8sPatch,
  K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
import bundledCommunityYaml from '../../catalog/community.yaml';
import bmhDeployYaml from '../../catalog/deploy/oct-baremetal.yaml';
import bondDeployYaml from '../../catalog/deploy/oct-network-bond.yaml';
import bannerDeployYaml from '../../catalog/deploy/oct-banner.yaml';
import windowsBuilderDeployYaml from '../../catalog/deploy/oct-windows-builder.yaml';
import storageBenchDeployYaml from '../../catalog/deploy/oct-storage-bench.yaml';
import odfMacvlansDeployYaml from '../../catalog/deploy/oct-odf-macvlans.yaml';
import helloWorldDeployYaml from '../../catalog/deploy/oct-hello-world.yaml';
import bridgeDeployYaml from '../../catalog/deploy/oct-network-bridge.yaml';
import dhcpDeployYaml from '../../catalog/deploy/oct-network-dhcp.yaml';
import vlanDeployYaml from '../../catalog/deploy/oct-network-vlan.yaml';
import shiftOnShiftVirtDeployYaml from '../../catalog/deploy/oct-shift-on-shift-virt.yaml';
import { ConfigMapModel, ConsoleOperatorModel, DeploymentModel, modelForKind } from './k8s-models';
import { bundleBlocker, semverFromImage, storefrontBlocker } from './bundle-check';
import {
  CACHE_CONFIGMAP,
  CommunityTool,
  DEFAULT_CHANNEL,
  emptyStats,
  EXTERNAL_CONFIGMAP,
  ExtensionStats,
  InstalledMap,
  InstalledRecord,
  PublicCatalogExtension,
  StatsMap,
  STOREFRONT_NS,
  STOREFRONT_VERSION,
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
import { applyYaml, applyVersionImage, generatePluginManifests, missingNamespaces, splitYamlDocs } from './apply-yaml';
import {
  DEFAULT_POLICY,
  Decision,
  evaluate,
  parsePolicy,
  Policy,
  POLICY_CONFIGMAP,
  POLICY_KEY,
  telemetryAllows,
} from './policy';
import { deriveProfile, parseBundle, rbacDiff, SecurityProfile } from './security-profile';
import type { SecuritySpec } from './security-spec';
import { fetchDeployYaml, fetchPublicCatalog, postPublicDownload, postPublicRating } from './public-catalog';
import {
  ensureProvisioningWatchAllNamespaces,
  formatWatchAllNamespacesPatchError,
  isBareMetalHostsTool,
  SKIP_WATCH_ALL_NAMESPACES_WARNING,
} from './metal3-provisioning';

const BUNDLED_DEPLOY: Record<string, string> = {
  'oct-baremetal': bmhDeployYaml,
  'oct-network-bond': bondDeployYaml,
  'oct-banner': bannerDeployYaml,
  'oct-windows-builder': windowsBuilderDeployYaml,
  'oct-storage-bench': storageBenchDeployYaml,
  'oct-odf-macvlans': odfMacvlansDeployYaml,
  'oct-hello-world': helloWorldDeployYaml,
  'oct-network-bridge': bridgeDeployYaml,
  'oct-network-dhcp': dhcpDeployYaml,
  'oct-network-vlan': vlanDeployYaml,
  'oct-shift-on-shift-virt': shiftOnShiftVirtDeployYaml,
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

export type PolicyState = {
  policy: Policy;
  /** default: no policy ConfigMap; configmap: read it; error: couldn't read it (defaults apply). */
  source: 'default' | 'configmap' | 'error';
  /** Problems to show in a banner (unreadable policy, invalid values). */
  warnings: string[];
};

/**
 * Read the cluster policy. Fails open: any problem yields the defaults plus a
 * warning, never an exception, so a broken policy can't take the catalog down.
 */
export async function loadPolicy(): Promise<PolicyState> {
  try {
    const cm = (await k8sGet({ model: ConfigMapModel, name: POLICY_CONFIGMAP, ns: STOREFRONT_NS })) as ConfigMapKind;
    const warnings: string[] = [];
    const policy = parsePolicy(cm?.data?.[POLICY_KEY], warnings);
    return { policy, source: 'configmap', warnings };
  } catch (err) {
    const e = err as { json?: { code?: number; reason?: string }; code?: number; message?: string };
    if (e?.json?.code === 404 || e?.json?.reason === 'NotFound' || e?.code === 404) {
      return { policy: { ...DEFAULT_POLICY }, source: 'default', warnings: [] };
    }
    const why = e?.message || String(err);
    return {
      policy: { ...DEFAULT_POLICY },
      source: 'error',
      warnings: [`Could not read the cluster policy (${why}); using the defaults.`],
    };
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
  const cachedVersion = existing?.data?.['bundled-version'];
  const needsSeed = !existing?.data?.['community.yaml'];
  const needsReseed = !needsSeed && cachedVersion !== STOREFRONT_VERSION;

  if (!needsSeed && !needsReseed) return;

  const data: Record<string, string> = {
    'community.yaml': bundledCommunityYaml,
    'bundled-version': STOREFRONT_VERSION,
    'sync.json': JSON.stringify({
      ok: false,
      source: 'bundled',
      checkedAt: new Date().toISOString(),
      message: needsReseed
        ? `Re-seeded: storefront upgraded ${cachedVersion || 'unknown'} → ${STOREFRONT_VERSION}.`
        : 'Seeded from the plugin bundle.',
    } as SyncStatus),
  };
  if (needsSeed) {
    data['stats.json'] = '{}';
  }
  if (needsReseed && existing?.data?.['installed.json']) {
    data['installed.json'] = existing.data['installed.json'];
  }
  await writeConfigMap(CACHE_CONFIGMAP, data);
}

// New releases must reach clusters the same day: an hour keeps the
// "Update available" lag short while reads stay cheap (unthrottled, cached at the edge).
const SYNC_TTL_MS = 60 * 60 * 1000; // 1 hour

/** force skips the SYNC_TTL_MS wait (the hub's "Check for updates"). */
export async function refreshPublicCatalogIntoCache(force = false): Promise<SyncStatus> {
  const { policy } = await loadPolicy();
  if (policy.publicCatalog === 'off') {
    return {
      ok: true,
      source: 'cache',
      checkedAt: new Date().toISOString(),
      message: 'Public catalog sync is turned off by the cluster policy.',
    };
  }
  // Skip sync if the last successful check is younger than SYNC_TTL_MS
  try {
    if (force) throw new Error('forced');
    const cm = await getConfigMap(CACHE_CONFIGMAP);
    const lastSync = syncFromCache(cm || undefined);
    if (lastSync.ok && lastSync.checkedAt) {
      const age = Date.now() - new Date(lastSync.checkedAt).getTime();
      if (age < SYNC_TTL_MS) {
        return lastSync;
      }
    }
  } catch {
    /* proceed with sync */
  }

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
  for (const raw of result.catalog.extensions || []) {
    const ext = policy.publicCatalog === 'metadata-only' ? withoutRemoteManifests(raw) : raw;
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

/**
 * Count an Add (never an Update). The public counter only gets community tools,
 * and only when the cluster policy's telemetry setting allows it.
 */
export async function incrementDownloads(
  id: string,
  source: 'community' | 'external',
  policy: Policy = DEFAULT_POLICY,
): Promise<void> {
  await patchStats((stats) => {
    const cur = stats[id] || emptyStats();
    cur.downloads = (cur.downloads || 0) + 1;
    stats[id] = cur;
  });
  if (source === 'community' && telemetryAllows(policy, 'download')) {
    void postPublicDownload(id);
  }
}

export async function setClusterRating(
  id: string,
  rating: number,
  source: 'community' | 'external',
  clusterHash?: string,
  policy: Policy = DEFAULT_POLICY,
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
  if (source === 'community' && clusterHash && telemetryAllows(policy, 'rating')) {
    void postPublicRating(id, stars, clusterHash);
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

/**
 * Why this storefront cannot install `version` correctly, or '' when it can.
 * A storefront older than a tool release only has the tool's previous bundle;
 * installing the newer version from it would run the new plugin against old
 * companions and RBAC (and record the update as done). Such a version needs
 * its own manifest on the catalog row, or a newer storefront. Older versions
 * and plugin-only tools are unaffected.
 */
export function installBlocker(tool: CommunityTool, version?: ToolVersion): string {
  if (!version) return '';
  const tooOld = storefrontBlocker(tool.spec.displayName, STOREFRONT_VERSION, version.minStorefront);
  if (tooOld) return tooOld;
  if (version.deployYAML?.trim() || version.deployURL) return '';
  const bundled = BUNDLED_DEPLOY[tool.metadata.name] || BUNDLED_DEPLOY[tool.spec.consolePlugin];
  return bundled ? bundleBlocker(tool.spec.displayName, tool.spec.consolePlugin, bundled, version.version) : '';
}

export async function resolveDeployYaml(
  tool: CommunityTool,
  version?: ToolVersion,
  clusterMinor?: string,
): Promise<string> {
  const image = imageForRow(version, clusterMinor, tool.spec.image);
  const deployYAML = version?.deployYAML || tool.spec.deployYAML;
  const deployURL = version?.deployURL || tool.spec.deployURL;
  const blocker = installBlocker(tool, version);
  if (blocker) throw new Error(blocker);
  // A row's own manifest is version-specific, so it wins over the bundle,
  // which only matches the release this storefront was built with.
  let yaml = '';
  if (deployYAML?.trim()) yaml = deployYAML;
  else if (deployURL) {
    const fetched = await fetchDeployYaml(deployURL);
    if (fetched.ok && fetched.yaml) yaml = fetched.yaml;
    else throw new Error(fetched.reason || `Could not fetch deploy YAML from ${deployURL}`);
  } else {
    const bundled = BUNDLED_DEPLOY[tool.metadata.name] || BUNDLED_DEPLOY[tool.spec.consolePlugin];
    if (bundled) yaml = bundled;
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

/** Public catalog entry without remote install manifests (policy publicCatalog: metadata-only). */
function withoutRemoteManifests(ext: PublicCatalogExtension): PublicCatalogExtension {
  return {
    ...ext,
    versions: (ext.versions || []).map((v) => {
      const row = { ...(v as ToolVersion & { deployUrl?: string }) };
      delete row.deployURL;
      delete row.deployYAML;
      delete row.deployUrl;
      return row;
    }),
  };
}

/** Everything the install review screen shows, and the YAML that will be applied. */
export type PreparedInstall = {
  tool: CommunityTool;
  version?: ToolVersion;
  action: 'add' | 'update';
  /** Exactly what will be applied after review. */
  yaml: string;
  profile: SecurityProfile;
  declared?: SecuritySpec;
  decision: Decision;
  policy: Policy;
  policyWarnings: string[];
  /** Rules added or removed compared with the Roles/ClusterRoles on the cluster (updates). */
  rbacChanges: { role: string; added: string[]; removed: string[] }[];
  /** Set when the cluster's current RBAC couldn't be read for the comparison. */
  rbacCompareError?: string;
  /** Why this can't be installed on this cluster at all (independent of policy). */
  problems: string[];
  publicOnly: boolean;
};

/**
 * The Roles and ClusterRoles from `yaml` as they exist on the cluster now, as a
 * YAML stream (JSON documents), so rbacDiff can compare them with the bundle.
 * Roles that don't exist yet are left out, so all of their rules count as added.
 */
async function liveRbacYaml(yaml: string): Promise<string> {
  const docs: string[] = [];
  for (const d of parseBundle(yaml)) {
    if (d.kind !== 'ClusterRole' && d.kind !== 'Role') continue;
    const model = modelForKind(d.kind);
    if (!model || !d.metadata?.name) continue;
    try {
      const live = (await k8sGet({ model, name: d.metadata.name, ns: d.metadata.namespace })) as K8sResourceCommon;
      docs.push(JSON.stringify(live));
    } catch (e) {
      const err = e as { json?: { code?: number }; code?: number };
      if (err?.json?.code === 404 || err?.code === 404) continue;
      throw e;
    }
  }
  return docs.join('\n---\n');
}

/**
 * Resolve the manifests an install would apply, derive their security profile and
 * evaluate the cluster policy. Nothing is applied. Pass the result's `yaml` to
 * addExtension as `reviewedYaml` so the user gets exactly what they reviewed.
 */
export async function prepareInstall(
  tool: CommunityTool,
  version: ToolVersion | undefined,
  clusterMinor: string,
  action: 'add' | 'update',
): Promise<PreparedInstall> {
  const [{ policy, warnings: policyWarnings }, yaml] = await Promise.all([
    loadPolicy(),
    resolveDeployYaml(tool, version, clusterMinor),
  ]);
  const profile = deriveProfile(yaml);
  const declared = version?.security || tool.spec.security;
  const ownManifest = Boolean(version?.deployYAML?.trim() || (!version?.deployYAML && tool.spec.deployYAML?.trim()));
  const deployURL = ownManifest ? undefined : version?.deployURL || tool.spec.deployURL;
  const bundledIds = new Set(bundledCommunityTools().map((t) => t.metadata.name));
  const publicOnly = tool.spec.source === 'community' && !bundledIds.has(tool.metadata.name);

  let rbacChanges: PreparedInstall['rbacChanges'] = [];
  let rbacCompareError: string | undefined;
  if (action === 'update') {
    try {
      rbacChanges = rbacDiff(await liveRbacYaml(yaml), yaml);
    } catch (e) {
      rbacCompareError = e instanceof Error ? e.message : String(e);
    }
  }
  const problems: string[] = [];
  const missing = await missingNamespaces(splitYamlDocs(yaml));
  if (missing.length) {
    problems.push(
      `Namespace ${missing.join(', ')} does not exist on this cluster, and this tool puts objects there. It may need an operator (for example ODF) installed first.`,
    );
  }
  const decision = evaluate(policy, {
    toolId: tool.metadata.name,
    source: tool.spec.source,
    publicOnly,
    action,
    profile,
    declared,
    deployURL,
    rbacAdded: rbacChanges.map((r) => ({ role: r.role, added: r.added })),
  });
  return {
    tool,
    version,
    action,
    yaml,
    profile,
    declared,
    decision,
    policy,
    policyWarnings,
    rbacChanges,
    rbacCompareError,
    problems,
    publicOnly,
  };
}

export type AddExtensionOpts = {
  storageClassName?: string;
  /**
   * Bare Metal Hosts only. When true (default for that tile), patch
   * Provisioning spec.watchAllNamespaces with the user's console token.
   * When false, still install the plugin and return a warning.
   */
  enableWatchAllNamespaces?: boolean;
  /** Apply exactly this YAML (what the user reviewed) instead of resolving it again. */
  reviewedYaml?: string;
  /** add counts a download; update doesn't. Default add. */
  action?: 'add' | 'update';
  /** Cluster policy, for the telemetry setting. */
  policy?: Policy;
};

export type AddExtensionResult = {
  log: string[];
  warnings: string[];
};

export async function addExtension(
  tool: CommunityTool,
  version?: ToolVersion,
  clusterMinor?: string,
  opts: AddExtensionOpts = {},
): Promise<AddExtensionResult> {
  const warnings: string[] = [];
  if (isBareMetalHostsTool(tool)) {
    if (opts.enableWatchAllNamespaces === false) {
      warnings.push(SKIP_WATCH_ALL_NAMESPACES_WARNING);
    } else {
      try {
        await ensureProvisioningWatchAllNamespaces();
      } catch (e) {
        warnings.push(formatWatchAllNamespacesPatchError(e));
      }
    }
  }
  const image = imageForRow(version, clusterMinor, tool.spec.image);
  const yaml = opts.reviewedYaml || (await resolveDeployYaml(tool, version, clusterMinor));
  const storageClassName =
    opts.storageClassName !== undefined ? opts.storageClassName : tool.spec.storageClassName;
  const log = await applyYaml(yaml, { storageClassName, extensionId: tool.metadata.name });
  await setPluginEnabled(tool.spec.consolePlugin, true);
  if ((opts.action || 'add') === 'add') {
    await incrementDownloads(tool.metadata.name, tool.spec.source, opts.policy);
  }
  await recordInstalled(tool.metadata.name, {
    version: version?.version || '',
    channel: version?.channel || tool.spec.defaultChannel || DEFAULT_CHANNEL,
    image,
  });
  return { log, warnings };
}

type PluginBackend = K8sResourceCommon & {
  spec?: { backend?: { service?: { name?: string; namespace?: string } } };
};

/**
 * Installed version of an extension the storefront has no installed.json
 * record for (added by hand, by `oc apply`, or before records existed):
 * read the image of the Deployment behind its ConsolePlugin. A catalog row
 * with that exact image wins; otherwise the `<semver>-ocp<minor>` tag is used.
 * Without this no update is ever offered for such installs.
 */
export async function detectInstalledVersion(
  tool: CommunityTool,
  plugin: PluginBackend,
): Promise<string | undefined> {
  const svc = plugin.spec?.backend?.service;
  if (!svc?.name || !svc.namespace) return undefined;
  try {
    const dep = (await k8sGet({ model: DeploymentModel, name: svc.name, ns: svc.namespace })) as K8sResourceCommon & {
      spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
    };
    const containers = dep.spec?.template?.spec?.containers || [];
    const image = (containers.find((c) => c.name === 'plugin') || containers[0])?.image || '';
    if (!image) return undefined;
    const row = (tool.spec.versions || []).find((v) => v.version && v.image === image);
    return row?.version || semverFromImage(image);
  } catch {
    return undefined;
  }
}

/** Re-enable without changing the running image (no auto-upgrade). */
export async function enableExtension(tool: CommunityTool): Promise<void> {
  await setPluginEnabled(tool.spec.consolePlugin, true);
}

/** Default Remove: disable this ConsolePlugin only (leave Deployment; do not touch other tools). */
export async function removeExtension(tool: CommunityTool): Promise<void> {
  await setPluginEnabled(tool.spec.consolePlugin, false);
}

/** Remove an external tool from the external ConfigMap entirely (and disable the plugin). */
export async function removeExternalTool(toolId: string): Promise<void> {
  const cm = await getConfigMap(EXTERNAL_CONFIGMAP);
  const existing = externalToolsFromCache(cm || undefined);
  const match = existing.find((t) => t.metadata.name === toolId);
  if (match) {
    await setPluginEnabled(match.spec.consolePlugin, false);
  }
  const next = existing.filter((t) => t.metadata.name !== toolId);
  await writeConfigMap(EXTERNAL_CONFIGMAP, { 'tools.yaml': toCommunityYaml(next) });
}

export function statsFor(id: string, stats: StatsMap): ExtensionStats {
  return stats[id] || emptyStats();
}
