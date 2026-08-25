/** CommunityTool YAML / JSON schema. Keep in sync with docs/extension-standard.md and AGENTS.md. */

export const COMMUNITY_TOOL_API = 'communitytools.io/v1alpha1';
/** @deprecated alias — same value as COMMUNITY_TOOL_API */
export const COMMUNITY_TOOL_API_ALIAS = COMMUNITY_TOOL_API;
export const STOREFRONT_NS = 'oct-storefront';
export const CACHE_CONFIGMAP = 'community-tools-cache';
export const EXTERNAL_CONFIGMAP = 'community-tools-external';
export const PLUGIN_ID = 'oct-storefront';
export const CATALOG_PROXY = '/api/proxy/plugin/oct-storefront/catalog-service';
export const DEFAULT_CHANNEL = 'stable';

export type ToolCategory = 'compute' | 'storage' | 'network' | 'management';
export type ToolSource = 'community' | 'external';
export type CatalogSort = 'name' | 'downloads' | 'rating';

export type CommunityToolSpec = {
  displayName: string;
  description: string;
  category: ToolCategory;
  /** Bundled catalog entries are community; user-injected entries are always external. */
  source: ToolSource;
  git?: string;
  image?: string;
  /** ConsolePlugin CR name and consoles.operator.openshift.io spec.plugins entry. */
  consolePlugin: string;
  /** Console route opened by the Open link when the plugin is enabled. */
  href?: string;
  /** OpenShift versions this extension was validated on (e.g. "4.22"). Derived from versions[] when omitted. */
  validatedOn: string[];
  minOpenShift?: string;
  maxOpenShift?: string;
  deployURL?: string;
  deployYAML?: string;
  /**
   * Optional StorageClass for PVCs in the install bundle (Add UI default).
   * Empty / omitted uses the cluster default. PVC annotation
   * `communitytools.io/storage-class` is the YAML-level equivalent.
   */
  storageClassName?: string;
  /** Channel used when Add does not pin a semver. Default: stable. */
  defaultChannel?: string;
  /** Optional YAML pin. Add installs this semver if it matches the cluster OCP. */
  pinVersion?: string;
  /** Channel names (metadata). Selection uses versions[].channel. */
  channels?: Record<string, Record<string, unknown>>;
  /**
   * Two axes: extension semver (`version`) and OpenShift minors (`openshift`).
   * Image tags are `<semver>-ocp<major.minor>`. Add defaults to the newest stable
   * semver whose openshift list includes the cluster, then pulls that row's image.
   * Pinning `version` / `pinVersion` keeps legacy installs off newer releases.
   */
  versions?: ToolVersion[];
};

export type ToolVersion = {
  /** Extension semver, e.g. "1.1.0". Empty on legacy OCP-only rows. */
  version?: string;
  /** Release channel. Default: stable. */
  channel?: string;
  /** OpenShift minor(s) this image supports. String or list. */
  openshift: string | string[];
  minOpenShift?: string;
  maxOpenShift?: string;
  image?: string;
  gitRef?: string;
  deployURL?: string;
  deployYAML?: string;
};

export type CommunityTool = {
  apiVersion: typeof COMMUNITY_TOOL_API | string;
  kind: 'CommunityTool' | string;
  metadata: { name: string };
  spec: CommunityToolSpec;
};

export type ExtensionStats = {
  downloads: number;
  ratingSum: number;
  ratingCount: number;
  clusterRating?: number;
  publicDownloads?: number;
  publicRatingAverage?: number;
  publicRatingCount?: number;
};

export type StatsMap = Record<string, ExtensionStats>;

export type SyncStatus = {
  ok: boolean;
  source: 'public' | 'cache' | 'bundled';
  checkedAt?: string;
  message?: string;
};

export type InstalledRecord = {
  version: string;
  channel?: string;
  image?: string;
};

export type InstalledMap = Record<string, InstalledRecord>;

export type PublicCatalogExtension = {
  id: string;
  displayName?: string;
  description?: string;
  category?: ToolCategory;
  source?: ToolSource;
  git?: string;
  image?: string;
  consolePlugin?: string;
  href?: string;
  validatedOn?: string[];
  minOpenShift?: string;
  maxOpenShift?: string;
  defaultChannel?: string;
  pinVersion?: string;
  storageClassName?: string;
  versions?: ToolVersion[];
  downloads?: number;
  rating?: { average?: number; count?: number };
};

export type PublicCatalog = {
  apiVersion?: string;
  kind?: string;
  generatedAt?: string;
  extensions?: PublicCatalogExtension[];
};

export type CatalogItem = {
  id: string;
  tool: CommunityTool;
  stats: ExtensionStats;
  installed: boolean;
  enabled: boolean;
  installedVersion?: string;
  updateAvailable?: ToolVersion;
};

export const CATEGORIES: ToolCategory[] = ['compute', 'storage', 'network', 'management'];

export function emptyStats(): ExtensionStats {
  return { downloads: 0, ratingSum: 0, ratingCount: 0 };
}

export function ratingAverage(stats: ExtensionStats, preferPublic: boolean): number {
  if (preferPublic && stats.publicRatingCount && stats.publicRatingCount > 0) {
    return stats.publicRatingAverage || 0;
  }
  if (stats.ratingCount <= 0) return 0;
  return stats.ratingSum / stats.ratingCount;
}

export function downloadCount(stats: ExtensionStats, preferPublic: boolean): number {
  if (preferPublic && typeof stats.publicDownloads === 'number') {
    return stats.publicDownloads;
  }
  return stats.downloads;
}

export function parseVersionFilter(version: string): string {
  const m = version.trim().match(/^(\d+\.\d+)/);
  return m ? m[1] : version.trim();
}

export function openshiftList(row: ToolVersion): string[] {
  const raw = row.openshift;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map(parseVersionFilter).filter(Boolean);
}

export function versionLabel(row: ToolVersion): string {
  const ocp = openshiftList(row).join(', ');
  if (row.version) return ocp ? `${row.version} (OpenShift ${ocp})` : row.version;
  return ocp || row.image || 'default';
}

export function versionKey(row: ToolVersion): string {
  const ocp = openshiftList(row).join(',');
  if (row.version && ocp) return `${row.version}+ocp${ocp}`;
  return row.version || ocp || row.image || '';
}

/** Canonical registry tag: `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). */
export function combinedImageTag(semver: string, ocpMinor: string): string {
  const v = (semver || '').replace(/^v/, '').trim();
  const ocp = parseVersionFilter(ocpMinor);
  if (!v || !ocp) return '';
  return `${v}-ocp${ocp}`;
}

/**
 * Catalog/install image for a versions[] row.
 * Uses the catalog image when it is already the combined tag; otherwise rewrites a
 * bare `:1.1.0` / `:4.22` alias to `<semver>-ocp<minor>` using the cluster minor
 * when that minor is in the row's openshift list (else the row's only minor).
 */
export function imageForRow(
  row: ToolVersion | undefined,
  clusterMinor?: string,
  fallback?: string,
): string {
  const image = row?.image || fallback || '';
  if (!image || image.includes('@sha256:')) return image;
  const semver = (row?.version || '').replace(/^v/, '').trim();
  if (!semver) return image;
  const listed = row ? openshiftList(row) : [];
  const cluster = parseVersionFilter(clusterMinor || '');
  let ocp = '';
  if (cluster && (listed.length === 0 || listed.includes(cluster))) ocp = cluster;
  else if (listed.length === 1) ocp = listed[0];
  const wanted = combinedImageTag(semver, ocp);
  if (!wanted) return image;
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon <= lastSlash) return `${image}:${wanted}`;
  return `${image.slice(0, lastColon)}:${wanted}`;
}

export function openshiftMinors(spec: CommunityToolSpec): string[] {
  const fromVersions = (spec.versions || []).flatMap((x) => openshiftList(x));
  const fromValidated = (spec.validatedOn || []).map(parseVersionFilter);
  return Array.from(new Set([...fromVersions, ...fromValidated].filter(Boolean)));
}

export function matchesOpenShift(spec: CommunityToolSpec, version: string): boolean {
  if (!version) return true;
  const v = parseVersionFilter(version);
  if (openshiftMinors(spec).includes(v)) return true;
  if (spec.minOpenShift || spec.maxOpenShift) {
    const min = spec.minOpenShift ? parseVersionFilter(spec.minOpenShift) : '';
    const max = spec.maxOpenShift ? parseVersionFilter(spec.maxOpenShift) : '';
    if (min && compareMinor(v, min) < 0) return false;
    if (max && compareMinor(v, max) > 0) return false;
    if (min || max) return true;
  }
  return false;
}

export function versionMatchesCluster(row: ToolVersion, clusterMinor: string): boolean {
  if (!clusterMinor) return true;
  const v = parseVersionFilter(clusterMinor);
  const list = openshiftList(row);
  if (list.includes(v)) return true;
  const min = row.minOpenShift ? parseVersionFilter(row.minOpenShift) : '';
  const max = row.maxOpenShift ? parseVersionFilter(row.maxOpenShift) : '';
  if (min || max) {
    if (min && compareMinor(v, min) < 0) return false;
    if (max && compareMinor(v, max) > 0) return false;
    return Boolean(min || max);
  }
  return list.length === 0;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] {
  const m = (v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0];
}

export function toolVersions(spec: CommunityToolSpec): ToolVersion[] {
  if (spec.versions?.length) return spec.versions;
  const validated = spec.validatedOn || [];
  if (validated.length) {
    return validated.map((openshift) => ({
      openshift,
      image: spec.image,
      deployURL: spec.deployURL,
      deployYAML: spec.deployYAML,
      channel: DEFAULT_CHANNEL,
    }));
  }
  if (spec.image || spec.deployURL || spec.deployYAML) {
    return [
      {
        openshift: '',
        image: spec.image,
        deployURL: spec.deployURL,
        deployYAML: spec.deployYAML,
        channel: DEFAULT_CHANNEL,
      },
    ];
  }
  return [];
}

export type VersionPick =
  | { status: 'matched' | 'single'; version: ToolVersion; clusterMinor: string; available: string[] }
  | {
      status: 'choose' | 'unsupported' | 'pinned-incompatible';
      version?: ToolVersion;
      clusterMinor: string;
      available: string[];
    };

export type PickVersionOpts = {
  channel?: string;
  pinVersion?: string;
};

/**
 * Pick a catalog row for Add.
 * Default: newest stable semver whose openshift list includes the cluster minor.
 * Never auto-select an OCP-incompatible row when cluster version is known.
 * pinVersion (or spec.pinVersion) installs that semver instead of the newest.
 */
export function pickToolVersion(
  spec: CommunityToolSpec,
  clusterMinor: string,
  opts: PickVersionOpts = {},
): VersionPick {
  const versions = toolVersions(spec);
  const cluster = parseVersionFilter(clusterMinor);
  const channel = opts.channel || spec.defaultChannel || DEFAULT_CHANNEL;
  const pin = opts.pinVersion || spec.pinVersion || '';
  const available = versions.map(versionLabel);

  if (pin) {
    const pinnedRows = versions.filter((row) => row.version === pin);
    if (!pinnedRows.length) {
      return { status: 'unsupported', clusterMinor: cluster, available };
    }
    const pinned =
      (cluster && pinnedRows.find((row) => versionMatchesCluster(row, cluster))) || pinnedRows[0];
    if (cluster && !versionMatchesCluster(pinned, cluster)) {
      return { status: 'pinned-incompatible', version: pinned, clusterMinor: cluster, available };
    }
    return { status: 'matched', version: pinned, clusterMinor: cluster, available };
  }

  const compatible = versions.filter((row) => versionMatchesCluster(row, cluster));
  const onChannel = compatible.filter((row) => (row.channel || DEFAULT_CHANNEL) === channel);
  const pool = onChannel.length ? onChannel : compatible;

  if (cluster && pool.length === 0) {
    return { status: 'unsupported', clusterMinor: cluster, available };
  }

  if (!cluster && versions.length > 1 && pool.length !== 1) {
    return { status: 'choose', clusterMinor: '', available };
  }

  const chosen = newestRelease(pool.length ? pool : versions);
  if (!chosen) {
    return {
      status: 'single',
      version: { openshift: '', image: spec.image, deployURL: spec.deployURL, deployYAML: spec.deployYAML },
      clusterMinor: cluster,
      available,
    };
  }
  return {
    status: pool.length === 1 && !cluster ? 'single' : 'matched',
    version: chosen,
    clusterMinor: cluster,
    available,
  };
}

/** Newest compatible stable (or defaultChannel) newer than the installed semver. Does not auto-apply. */
export function pickAvailableUpdate(
  spec: CommunityToolSpec,
  installedVersion: string | undefined,
  clusterMinor: string,
): ToolVersion | undefined {
  if (!installedVersion) return undefined;
  const picked = pickToolVersion(spec, clusterMinor);
  if (picked.status !== 'matched' && picked.status !== 'single') return undefined;
  const newest = picked.version;
  if (!newest?.version) return undefined;
  if (compareSemver(newest.version, installedVersion) > 0) return newest;
  return undefined;
}

export function findToolVersion(spec: CommunityToolSpec, key: string): ToolVersion | undefined {
  return toolVersions(spec).find((row) => versionKey(row) === key || versionLabel(row) === key);
}

export function detectWindowOpenShiftVersion(): string {
  try {
    const flags = (window as unknown as { SERVER_FLAGS?: { releaseVersion?: string } }).SERVER_FLAGS;
    return parseVersionFilter(flags?.releaseVersion || '');
  } catch {
    return '';
  }
}

function newestRelease(rows: ToolVersion[]): ToolVersion | undefined {
  if (!rows.length) return undefined;
  return [...rows].sort((a, b) => {
    const sem = compareSemver(b.version || '', a.version || '');
    if (sem !== 0) return sem;
    const ao = openshiftList(a)[0] || '';
    const bo = openshiftList(b)[0] || '';
    return compareMinor(bo, ao);
  })[0];
}

function compareMinor(a: string, b: string): number {
  const [am, ai] = a.split('.').map((n) => parseInt(n, 10) || 0);
  const [bm, bi] = b.split('.').map((n) => parseInt(n, 10) || 0);
  if (am !== bm) return am - bm;
  return ai - bi;
}
