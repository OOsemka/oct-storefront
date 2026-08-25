import { useCallback, useEffect, useMemo, useState } from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  CACHE_CONFIGMAP,
  CatalogItem,
  CatalogSort,
  CommunityTool,
  EXTERNAL_CONFIGMAP,
  STOREFRONT_NS,
  SyncStatus,
  ToolCategory,
  ToolVersion,
  downloadCount,
  matchesOpenShift,
  ratingAverage,
  detectWindowOpenShiftVersion,
  pickToolVersion,
  pickAvailableUpdate,
} from '../../utils/catalog-types';
import {
  addExtension,
  AddExtensionOpts,
  bundledCommunityTools,
  enableExtension,
  ensureCacheSeeded,
  externalToolsFromCache,
  installedFromCache,
  refreshPublicCatalogIntoCache,
  removeExtension,
  saveExternalTool,
  setClusterRating,
  statsFor,
  statsFromCache,
  syncFromCache,
  toolsFromCache,
} from '../../utils/catalog-actions';

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
  const installedMap = installedFromCache(cacheCm);
  const preferPublic = Boolean(sync.ok && sync.source === 'public');

  const items = useMemo(() => {
    const community = cacheCm ? toolsFromCache(cacheCm) : bundledCommunityTools();
    const external = externalToolsFromCache(externalCm);
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
        const installedVersion = installedMap[t.metadata.name]?.version;
        return {
          id: t.metadata.name,
          tool: t,
          stats: statsFor(t.metadata.name, stats),
          installed: enabled || pluginNames.has(plugin),
          enabled,
          installedVersion,
          updateAvailable: pickAvailableUpdate(t.spec, installedVersion, clusterVersion),
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
    clusterVersion,
  ]);

  const run = useCallback(async (id: string, fn: () => Promise<unknown>, okMessage: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(okMessage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const add = useCallback(
    (item: CatalogItem, version?: ToolVersion, opts?: AddExtensionOpts) =>
      run(
        item.id,
        () => addExtension(item.tool, version, clusterVersion, opts),
        `Added ${item.tool.spec.displayName}${version?.version ? ` ${version.version}` : ''}. Refresh the console to load the plugin.`,
      ),
    [run, clusterVersion],
  );

  const enable = useCallback(
    (item: CatalogItem) =>
      run(item.id, () => enableExtension(item.tool), `Enabled ${item.tool.spec.displayName} (running image unchanged).`),
    [run],
  );

  const update = useCallback(
    (item: CatalogItem, version?: ToolVersion) => {
      const next = version || item.updateAvailable;
      return run(
        item.id,
        () => addExtension(item.tool, next, clusterVersion),
        `Updated ${item.tool.spec.displayName} to ${next?.version || 'the latest compatible release'}. Refresh the console.`,
      );
    },
    [run, clusterVersion],
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

  const rate = useCallback(async (item: CatalogItem, stars: number) => {
    try {
      await setClusterRating(item.id, stars, item.tool.spec.source);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const addExternal = useCallback(
    async (tool: CommunityTool) => {
      setBusyId(tool.metadata.name);
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
        await saveExternalTool(tool);
        await addExtension(tool, picked.version, clusterVersion, {
          storageClassName: tool.spec.storageClassName,
        });
        setNotice(`Added external extension ${tool.spec.displayName}.`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [clusterVersion],
  );

  return {
    items,
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
    add,
    enable,
    update,
    remove,
    rate,
    addExternal,
  };
}
