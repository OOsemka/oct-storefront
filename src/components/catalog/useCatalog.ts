import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  CACHE_CONFIGMAP,
  CatalogItem,
  CatalogSort,
  CommunityTool,
  EXTERNAL_CONFIGMAP,
  PLUGIN_ID,
  STOREFRONT_NS,
  STOREFRONT_VERSION,
    SyncStatus,
  ToolCategory,
  ToolVersion,
  downloadCount,
  matchesOpenShift,
  ratingAverage,
  detectWindowOpenShiftVersion,
  pickToolVersion,
  pickAvailableUpdate,
  compatibleSemvers,
} from '../../utils/catalog-types';
import {
  addExtension,
  AddExtensionOpts,
  AddExtensionResult,
  bundledCommunityTools,
  loadPolicy,
  peekDeployYaml,
  PolicyState,
  prepareInstall,
  PreparedInstall,
  detectInstalledVersion,
  enableExtension,
  installBlocker,
  ensureCacheSeeded,
  externalToolsFromCache,
  installedFromCache,
  refreshPublicCatalogIntoCache,
  removeExtension,
  removeExternalTool,
  saveExternalTool,
  setClusterRating,
  statsFor,
  statsFromCache,
  syncFromCache,
  toolsFromCache,
} from '../../utils/catalog-actions';
import { deriveProfile, SecurityLevel } from '../../utils/security-profile';

type ConfigMapKind = K8sResourceCommon & { data?: Record<string, string> };
type ConsoleKind = K8sResourceCommon & { spec?: { plugins?: string[] } };
type PluginKind = K8sResourceCommon;
type ClusterVersionKind = K8sResourceCommon & {
  status?: { desired?: { version?: string }; history?: Array<{ version?: string; state?: string }> };
};

function clusterVersionString(cv?: ClusterVersionKind): string {
  const desired = cv?.status?.desired?.version || '';
  const completed = cv?.status?.history?.find((h) => h.state === 'Completed')?.version || '';
  const raw = desired || completed;
  const m = raw.match(/^(\d+\.\d+)/);
  return m ? m[1] : '';
}

// Tile labels derive a profile per tool; bundles rarely change, so cache by YAML text.
const levelCache = new Map<string, SecurityLevel | undefined>();
function levelOf(yaml: string): SecurityLevel | undefined {
  if (!yaml) return undefined;
  if (!levelCache.has(yaml)) {
    let level: SecurityLevel | undefined;
    try {
      level = deriveProfile(yaml).level;
    } catch {
      level = undefined;
    }
    levelCache.set(yaml, level);
  }
  return levelCache.get(yaml);
}

/** An install waiting for the user to confirm the review screen. */
export type PendingReview = {
  prep: PreparedInstall;
  confirm: () => void;
};

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function useCatalog(category: ToolCategory) {
  const [cacheCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: { version: 'v1', kind: 'ConfigMap' },
    name: CACHE_CONFIGMAP,
    namespace: STOREFRONT_NS,
  });
  const [externalCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: { version: 'v1', kind: 'ConfigMap' },
    name: EXTERNAL_CONFIGMAP,
    namespace: STOREFRONT_NS,
  });
  const [consoleCr] = useK8sWatchResource<ConsoleKind>({
    groupVersionKind: { group: 'operator.openshift.io', version: 'v1', kind: 'Console' },
    name: 'cluster',
  });
  const [plugins] = useK8sWatchResource<PluginKind[]>({
    groupVersionKind: { group: 'console.openshift.io', version: 'v1', kind: 'ConsolePlugin' },
    isList: true,
  });
  const [cv] = useK8sWatchResource<ClusterVersionKind>({
    groupVersionKind: { group: 'config.openshift.io', version: 'v1', kind: 'ClusterVersion' },
    name: 'version',
  });

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CatalogSort>('name');
  const [versionFilter, setVersionFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<PendingReview | null>(null);
  const [policyState, setPolicyState] = useState<PolicyState | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadPolicy().then((p) => {
      if (!cancelled) setPolicyState(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cluster hash for public rating dedup (SHA-256 of ClusterVersion UID)
  const clusterHashRef = useRef<string>('');
  useEffect(() => {
    const uid = cv?.metadata?.uid;
    if (uid && !clusterHashRef.current) {
      sha256(uid).then((hash) => {
        clusterHashRef.current = hash;
      });
    }
  }, [cv]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureCacheSeeded();
        if (!cancelled) {
          await refreshPublicCatalogIntoCache();
        }
      } catch {
        /* fail-open */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clusterVersion = clusterVersionString(cv) || detectWindowOpenShiftVersion();
  const enabledPlugins = consoleCr?.spec?.plugins || [];
  const pluginNames = new Set(
    (Array.isArray(plugins) ? plugins : []).map((p) => p.metadata?.name).filter(Boolean) as string[],
  );
  const stats = statsFromCache(cacheCm);
  const sync: SyncStatus = syncFromCache(cacheCm);
  const installedMap = useMemo(() => installedFromCache(cacheCm), [cacheCm]);
  const preferPublic = Boolean(sync.ok && sync.source === 'public');

  // Versions read from running Deployments for installs without an
  // installed.json record (see detectInstalledVersion).
  const [detected, setDetected] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const list = Array.isArray(plugins) ? plugins : [];
    const tools = [
      ...(cacheCm ? toolsFromCache(cacheCm) : bundledCommunityTools()),
      ...externalToolsFromCache(externalCm),
    ];
    (async () => {
      const found: Record<string, string> = {};
      for (const t of tools) {
        if (t.metadata.name === PLUGIN_ID || installedMap[t.metadata.name]?.version) continue;
        const plugin = list.find((p) => p.metadata?.name === t.spec.consolePlugin);
        if (!plugin) continue;
        const v = await detectInstalledVersion(t, plugin);
        if (v) found[t.metadata.name] = v;
      }
      if (!cancelled) {
        setDetected((prev) => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plugins, cacheCm, externalCm, installedMap]);

  const items = useMemo(() => {
    const community = cacheCm ? toolsFromCache(cacheCm) : bundledCommunityTools();
    const external = externalToolsFromCache(externalCm);
    const bundledIds = new Set(bundledCommunityTools().map((t) => t.metadata.name));
    const merged = new Map<string, CommunityTool>();
    for (const t of community) merged.set(t.metadata.name, t);
    for (const t of external) merged.set(t.metadata.name, t);

    const q = query.trim().toLowerCase();
    const list: CatalogItem[] = Array.from(merged.values())
      .filter((t) => t.spec.category === category)
      .filter((t) => {
        if (!q) return true;
        const hay = [t.spec.displayName, t.spec.description, t.spec.consolePlugin, t.spec.git || '']
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .filter((t) => matchesOpenShift(t.spec, versionFilter))
      .map((t) => {
        const plugin = t.spec.consolePlugin;
        const enabled = enabledPlugins.includes(plugin);
        const installedVersion =
          installedMap[t.metadata.name]?.version ||
          (t.metadata.name === PLUGIN_ID && (enabled || pluginNames.has(plugin))
            ? STOREFRONT_VERSION
            : undefined) ||
          (enabled || pluginNames.has(plugin) ? detected[t.metadata.name] : undefined);
        const newer = pickAvailableUpdate(t.spec, installedVersion, clusterVersion);
        const blocked = newer ? installBlocker(t, newer) : '';
        const picked = pickToolVersion(t.spec, clusterVersion);
        return {
          id: t.metadata.name,
          tool: t,
          stats: statsFor(t.metadata.name, stats),
          installed: enabled || pluginNames.has(plugin),
          enabled,
          installedVersion,
          updateAvailable: blocked ? undefined : newer,
          updateBlocked: blocked && newer?.version ? { version: newer.version, reason: blocked } : undefined,
          compatibleSemvers: compatibleSemvers(t.spec, clusterVersion),
          securityLevel: levelOf(peekDeployYaml(t, picked.version)),
          publicOnly: t.spec.source === 'community' && !bundledIds.has(t.metadata.name),
        };
      });

    list.sort((a, b) => {
      if (sort === 'downloads') {
        return downloadCount(b.stats, preferPublic) - downloadCount(a.stats, preferPublic);
      }
      if (sort === 'rating') {
        return ratingAverage(b.stats, preferPublic) - ratingAverage(a.stats, preferPublic);
      }
      return a.tool.spec.displayName.localeCompare(b.tool.spec.displayName);
    });
    return list;
  }, [
    cacheCm,
    externalCm,
    category,
    query,
    versionFilter,
    sort,
    stats,
    enabledPlugins,
    pluginNames,
    preferPublic,
    installedMap,
    detected,
    clusterVersion,
  ]);

  const run = useCallback(async (id: string, fn: () => Promise<unknown>, okMessage: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const result = await fn();
      setNotice(okMessage);
      if (result && typeof result === 'object' && 'warnings' in result) {
        const warnings = (result as { warnings?: string[] }).warnings;
        if (warnings?.length) setWarning(warnings.join(' '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  /**
   * Every install goes through here: resolve and evaluate first, then either apply
   * straight away (plugin-only tools under the default policy: today's one click)
   * or open the review screen and apply only after the user confirms.
   */
  const gated = useCallback(
    async (
      id: string,
      tool: CommunityTool,
      version: ToolVersion | undefined,
      action: 'add' | 'update',
      apply: (prep: PreparedInstall) => Promise<AddExtensionResult>,
      okMessage: string,
    ) => {
      setBusyId(id);
      setError(null);
      setNotice(null);
      setWarning(null);
      let prep: PreparedInstall;
      try {
        prep = await prepareInstall(tool, version, clusterVersion, action);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusyId(null);
        return;
      }
      const go = () =>
        run(
          id,
          async () => {
            const result = await apply(prep);
            // Reasons that didn't need a review are still worth showing afterwards.
            const notes = prep.decision.reasons.map((r) => r.message);
            return { ...result, warnings: [...prep.policyWarnings, ...notes, ...result.warnings] };
          },
          okMessage,
        );
      if (!prep.decision.review && prep.decision.outcome !== 'block' && prep.problems.length === 0) {
        await go();
        return;
      }
      setBusyId(null);
      setReview({
        prep,
        confirm: () => {
          setReview(null);
          void go();
        },
      });
    },
    [run, clusterVersion],
  );

  const cancelReview = useCallback(() => setReview(null), []);

  const add = useCallback(
    (item: CatalogItem, version?: ToolVersion, opts?: AddExtensionOpts) =>
      gated(
        item.id,
        item.tool,
        version,
        'add',
        (prep) => addExtension(item.tool, version, clusterVersion, { ...opts, reviewedYaml: prep.yaml, action: 'add', policy: prep.policy }),
        `Added ${item.tool.spec.displayName}${version?.version ? ` ${version.version}` : ''}. Refresh the console to load the plugin.`,
      ),
    [gated, clusterVersion],
  );

  const enable = useCallback(
    (item: CatalogItem) =>
      run(item.id, () => enableExtension(item.tool), `Enabled ${item.tool.spec.displayName} (running image unchanged).`),
    [run],
  );

  const update = useCallback(
    (item: CatalogItem, version?: ToolVersion) => {
      const next = version || item.updateAvailable;
      return gated(
        item.id,
        item.tool,
        next,
        'update',
        (prep) => addExtension(item.tool, next, clusterVersion, { reviewedYaml: prep.yaml, action: 'update', policy: prep.policy }),
        `Updated ${item.tool.spec.displayName} to ${next?.version || 'the latest compatible release'}. Refresh the console.`,
      );
    },
    [gated, clusterVersion],
  );

  const remove = useCallback(
    (item: CatalogItem) =>
      run(
        item.id,
        () => removeExtension(item.tool),
        `Removed ${item.tool.spec.displayName} from the console (Deployment left in place).`,
      ),
    [run],
  );

  const removeFromCatalog = useCallback(
    (item: CatalogItem) =>
      run(
        item.id,
        () => removeExternalTool(item.id),
        `Removed ${item.tool.spec.displayName} from the external catalog and disabled the plugin.`,
      ),
    [run],
  );

  const rate = useCallback(async (item: CatalogItem, stars: number) => {
    try {
      await setClusterRating(item.id, stars, item.tool.spec.source, clusterHashRef.current, policyState?.policy);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [policyState]);

  const addExternal = useCallback(
    async (tool: CommunityTool) => {
      setError(null);
      try {
        const picked = pickToolVersion(tool.spec, clusterVersion);
        if (picked.status === 'unsupported' || picked.status === 'pinned-incompatible') {
          throw new Error(
            `No compatible spec.versions entry for OpenShift ${picked.clusterMinor}. Available: ${picked.available.join(', ') || 'none'}.`,
          );
        }
        if (picked.status === 'choose') {
          throw new Error(
            'Cluster OpenShift version is unknown. Provide a single spec.versions entry (or pinVersion) matching this cluster.',
          );
        }
        // Saved to the external catalog only once the user confirms the install.
        await gated(
          tool.metadata.name,
          tool,
          picked.version,
          'add',
          async (prep) => {
            await saveExternalTool(tool);
            return addExtension(tool, picked.version, clusterVersion, {
              storageClassName: tool.spec.storageClassName,
              reviewedYaml: prep.yaml,
              action: 'add',
              policy: prep.policy,
            });
          },
          `Added external extension ${tool.spec.displayName}.`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [clusterVersion, gated],
  );

  /** Check the public catalog now instead of waiting for the hourly sync. */
  const checkNow = async () => {
    setChecking(true);
    setError(null);
    try {
      const status = await refreshPublicCatalogIntoCache(true);
      if (!status.ok) setWarning(status.message || 'Public catalog unreachable.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return {
    items,
    checking,
    checkNow,
    query,
    setQuery,
    sort,
    setSort,
    versionFilter,
    setVersionFilter,
    clusterVersion,
    sync,
    preferPublic,
    busyId,
    error,
    notice,
    warning,
    add,
    enable,
    update,
    remove,
    removeFromCatalog,
    rate,
    addExternal,
    review,
    cancelReview,
    policyState,
  };
}
