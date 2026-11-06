import { loadAll } from 'js-yaml';
import { compareSemver } from './catalog-types';

/**
 * `quay.io/org/oct-x:1.2.3-ocp4.22` -> `1.2.3`.
 * A digest-pinned reference keeps its tag for humans and tooling
 * (`quay.io/org/oct-x:1.2.3-ocp4.22@sha256:...` -> `1.2.3`); a digest with no
 * tag (`quay.io/org/oct-x@sha256:...`) has no version and returns undefined.
 */
export function semverFromImage(image: string): string | undefined {
  const ref = image.split('@')[0];
  if (ref.lastIndexOf(':') <= ref.lastIndexOf('/')) return undefined;
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  const m = tag.match(/^v?(\d+\.\d+\.\d+)(?:-ocp\d+\.\d+)?$/);
  return m ? m[1] : undefined;
}

type BundleDoc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
};

function bundleDocs(yaml: string): BundleDoc[] {
  try {
    return (loadAll(yaml || '') as BundleDoc[]).filter((d) => d && typeof d === 'object');
  } catch {
    return [];
  }
}

/** Semver of the plugin image in a deploy bundle. */
export function bundleVersion(yaml: string, pluginName: string): string | undefined {
  const dep = bundleDocs(yaml).find((d) => d.kind === 'Deployment' && d.metadata?.name === pluginName);
  const containers = dep?.spec?.template?.spec?.containers || [];
  const image = (containers.find((c) => c.name === 'plugin') || containers[0])?.image || '';
  return image ? semverFromImage(image) : undefined;
}

/**
 * True when a bundle carries more than the plugin: a companion Deployment
 * (orchestrator, discovery service, ...) or a CRD. Installing another version
 * from such a bundle only swaps the plugin image, so the companions stay at
 * the bundle's version.
 */
export function bundleHasCompanions(yaml: string, pluginName: string): boolean {
  return bundleDocs(yaml).some(
    (d) => d.kind === 'CustomResourceDefinition' || (d.kind === 'Deployment' && d.metadata?.name !== pluginName),
  );
}

/**
 * Why `version` cannot be installed from this bundle, or '' when it can.
 * A storefront older than a tool release only has the previous bundle;
 * installing the newer version from it would run the new plugin against old
 * companions and RBAC, and record the update as done. Older versions and
 * plugin-only tools are unaffected.
 */
export function bundleBlocker(displayName: string, pluginName: string, bundled: string, version?: string): string {
  if (!version || !bundleHasCompanions(bundled, pluginName)) return '';
  const have = bundleVersion(bundled, pluginName);
  if (!have || compareSemver(version, have) <= 0) return '';
  return `${displayName} ${version} needs a newer Community Tools Storefront: this one only has the ${have} manifests. Update the storefront first.`;
}

/**
 * Why this storefront is too old for a catalog row that sets `minStorefront`, or ''.
 * Rows use it when their manifest needs something only newer storefronts can apply
 * (for example a NetworkPolicy). Older storefronts ignore the field entirely.
 */
export function storefrontBlocker(displayName: string, running: string, minStorefront?: string): string {
  const min = (minStorefront || '').trim();
  if (!min || compareSemver(running, min) >= 0) return '';
  return `${displayName} needs storefront ${min} or newer (this is ${running}). Update the storefront first.`;
}
