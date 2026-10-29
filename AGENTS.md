# OpenShift Community Tools — storefront (catalog)

This repository is the **OCT storefront**: catalog hubs only.
**Community project. Not officially supported by Red Hat.**

Directory (preferred): `oct-storefront`. Plugin ID: **`oct-storefront`**.

## Modules

| Directory | Plugin ID | Image tags |
| --- | --- | --- |
| **oct-storefront** (this) | `oct-storefront` | `:1.x.x-ocp4.22` (required); optional aliases `:1.x.x` / `:4.22` |
| oct-baremetal | `oct-baremetal` | same scheme |
| oct-network-bond | `oct-network-bond` | same scheme |
| oct-banner | `oct-banner` | same scheme |
| oct-windows-builder | `oct-windows-builder` | same scheme |

This webpack bundle must **not** contain extension pages. Hubs list tiles; **Open** goes to the extension plugin. Do not rename plugin ID `oct-storefront` (breaking install). Do not `oc apply` unless asked.

**Current version:** `1.5.7` (package.json / consolePlugin.version). Companion `catalog-service` image: `oct-storefront-catalog:1.0.1`.

Hub pages show when the public catalog was last checked, with **Check for updates** (`refreshPublicCatalogIntoCache(true)` skips the one-hour `SYNC_TTL_MS`). The automatic sync still runs at most hourly on a Community Tools page load.

## Routing (React Router v6 via v5-compat)

Hub routes are registered as `console.page/route` extensions in `console-extensions.json`. In-page navigation uses `useNavigate` from `react-router-dom-v5-compat` (^6.30.0); there are no `Routes`/`Route` components in source. React Router 5 (`5.3.4`) is the Console host; the v5-compat bridge provides the v6 `useNavigate` hook.

## Catalog-service architecture

| Piece | Role |
| --- | --- |
| **catalog-service** (`catalog-service/`, Go 1.22) | In-cluster HTTP(S) sidecar. Proxies `GET /api/v1/public-catalog` and stats POSTs to `COMMUNITY_TOOLS_CATALOG_URL` (3–10s timeouts). `GET /api/v1/fetch-yaml` fetches deploy manifests only over https from `raw.githubusercontent.com`, `gitlab.com`, `codeberg.org`, the catalog host, and hosts in `FETCH_YAML_ALLOWED_HOSTS` (redirects checked too); never make it an open proxy. |
| **community-tools-cache** ConfigMap | Namespace `oct-storefront`. Seeded from bundled `catalog/community.yaml` on first hub mount; refreshed from public catalog via proxy. Keys: `community.yaml`, `stats.json`, `sync.json` (`checkedAt`/`ok`/`source`), `installed.json`, `bundled-version`. The public catalog is re-fetched on a hub page load when the last successful sync is older than **1 hour** (`SYNC_TTL_MS`), so a newly seeded release reaches clusters within about an hour of someone opening Community Tools. A storefront version change re-seeds from the bundled catalog (keeping `installed.json`). On public failure, fail-opens to cache/bundled. |
| **community-tools-external** ConfigMap | Sibling CM for externally-added YAML tools. |
| **useCatalog** hook (`src/utils/catalog-actions.ts`, `src/components/catalog/useCatalog.ts`) | `ensureCacheSeeded` → `refreshPublicCatalogIntoCache` → merge cache + external; `CategoryHubPage` renders `ExtensionTile`s. Tiles are not fetched live from the service on every render. |
| **Tile icons** (`src/utils/tile-icons.ts`, `src/assets/tiles/`) | Bundled SVGs registered under keys like `oct-baremetal`, `tiles/oct-baremetal.svg`. `resolveTileIcon` tries `spec.icon` → `metadata.name` → `consolePlugin`. Registered: `oct-baremetal`, `oct-banner`, `oct-network-bond`, `oct-network-bridge`, `oct-network-dhcp`, `oct-network-vlan`, `oct-hello-world`, `oct-storage-bench`, `oct-odf-macvlans`, `oct-storefront`, `oct-windows-builder`, `oct-shift-on-shift-virt`. |

Proxy: `/api/proxy/plugin/oct-storefront/catalog-service`.

## Catalog apply vs plugin image

`oc apply` of `deploy/install.yaml` updates ConfigMap `community-tools-cache` (tile list, versions, Banner, `spec.icon` keys) and the Deployment spec. **Choose version**, **Change version**, and **tile icons** live in the **webpack plugin image**, not the ConfigMap. They change only when the Deployment **image tag** changes.

Keep `imagePullPolicy` IfNotPresent (the default for a named tag). Do **not** make Always the product default. Retagging `:1.0.0-ocp4.22` does not update nodes that already pulled that tag.

**Any storefront UI change** (picker, icons, copy) **bumps storefront semver** and `install.yaml` to a **new combined tag** that does not yet exist on cluster nodes (e.g. `1.2.0-ocp4.22`), and publish the matching `-ocp4.21` tag too. Never ship new plugin JS by retagging the only install tag. A catalog-only commit is visible after apply as new **tiles**; storefront **chrome** (icons, version button) stays on the old image.

## Navigation (two levels)

```
Administrator left-nav
  Community Tools          console.navigation/section  id: community-tools
    Compute                /community-tools/compute
    Storage                /community-tools/storage
    Network                /community-tools/network
    Management             /community-tools/management
```

## Catalog schema (CommunityTool) — two version axes

Keep two axes in the catalog. Image tags always encode both: `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). Not `ocp4.22-1.0.1`. **Always publish both** `<semver>-ocp4.21` and `<semver>-ocp4.22` (same digest if bits match). Catalog `versions[]` lists both minors when those tags exist.

1. **Extension semver** (`versions[].version`, git tag `v1.2.0`)
2. **OpenShift minor** (`versions[].openshift` list; optional git branch `ocp-4.22` when PF/API diverge)

```yaml
apiVersion: communitytools.io/v1alpha1
kind: CommunityTool
metadata:
  name: oct-my-tool
spec:
  displayName: My Tool
  category: compute             # compute | storage | network | management
  source: community
  git: https://github.com/example/oct-my-tool
  consolePlugin: oct-my-tool
  href: /my-tool
  icon: tiles/oct-my-tool.svg   # bundled storefront SVG; register in tile-icons.ts
  defaultChannel: stable
  channels:
    stable: {}
    candidate: {}
  # pinVersion: "1.1.0"        # optional; Add never jumps past this semver
  versions:
    - version: "1.1.0"
      channel: stable
      openshift: ["4.21"]
      image: quay.io/example/oct-my-tool:1.1.0-ocp4.21
      gitRef: v1.1.0
    - version: "1.1.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-my-tool:1.1.0-ocp4.22
      gitRef: v1.1.0
    - version: "1.2.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-my-tool:1.2.0-ocp4.22
      gitRef: v1.2.0
```

Every `versions[].image` (and any discovery/sidecar image the extension pulls) must be **public** and the **exact combined tag must exist**. Never list a (version, OpenShift minor) row unless that tag is public. `spec.href` must match a `console-extensions.json` route.

`spec.icon` is a bundled key (`tiles/oct-<name>.svg`), not a URL. Drop the SVG in `src/assets/tiles/`, register it in `src/utils/tile-icons.ts`, and keep `catalog/community.yaml` in sync with `deploy/install.yaml`. Tiles also fall back to plugin id.

Legacy rows (`openshift: "4.22"` without `version`) still parse.

`validatedOn` is derived from `versions[].openshift` when omitted. Alias: `spec.compatibility.openshift`. Spec-level `version:` is accepted as `pinVersion`.

## Add / Enable / Update / Remove

| Action | Behavior |
| --- | --- |
| **Add** (not installed) | Newest **stable** semver whose `openshift` list includes the cluster. One-click Add uses that default. **Choose version** (when more than one compatible semver exists) opens a picker, latest selected. Unknown cluster → user pick. Never pick an OCP-incompatible row when cluster minor is known. |
| **Pin** | `spec.pinVersion` (or spec `version:`) is the Add **default**, not a lock. The user can still pick another compatible semver. |
| **Enable** | Re-enables `spec.plugins`. **Does not** change the Deployment image. |
| **Update** | Explicit click to the newest compatible semver. Never auto. Tile shows “Update available (x.y.z)”. See **How Add and Update apply manifests** below for what an update changes, and when an update is held back (“x.y.z available; update the storefront first”). |
| **Change version** | Explicit picker of any compatible semver (including older). Same ConsolePlugin name; one running version. |
| **Remove** | Disables this plugin only. Leaves Deployment. Does not uninstall other tools or other pinned plugins. |
| **Same plugin ID** | One ConsolePlugin name = **one running version**. 1.2 does not run beside 1.1 under the same ID. Legacy stays on 1.1 by **not** clicking Update. |

Git: tags `v1.2.0`; optional `ocp-4.22` branch for PF/API. A `v1.2.0` tag can live on `ocp-4.22`. Images in catalog and install YAML are `:1.2.0-ocp4.22`. Same bits on two minors → two tags on one digest. Do not auto-migrate running clusters.

## How Add and Update apply manifests

`addExtension` → `resolveDeployYaml` → `applyYaml` (`src/utils/catalog-actions.ts`, `src/utils/apply-yaml.ts`).

**Which manifest:** the catalog row's `deployYAML`, else the row's `deployURL` (fetched through catalog-service), else the bundled `catalog/deploy/oct-<name>.yaml` (`BUNDLED_DEPLOY`), else generated plugin manifests. The selected version's combined plugin image is then set on the plugin Deployment (`applyVersionImage`).

**Bundles are version-specific.** A bundle is compiled into the storefront image and matches one tool release. For a tool whose bundle has **companions** (a CRD or a Deployment other than the plugin: Shift-on-Shift, Bare Metal Hosts, Windows Builder, Storage Bench), installing a version **newer than the bundle** from it would only swap the plugin image and leave the companions and RBAC behind. `installBlocker` / `bundleBlocker` (`src/utils/bundle-check.ts`) refuse that unless the row brings its own manifest; the tile shows “x.y.z available; update the storefront first” instead of Update. Older versions and plugin-only tools are unaffected. Consequence: **release the storefront with the regenerated bundle together with any companion-carrying tool release**, and on clusters update the storefront first.

**Objects that already exist:**

| Kind | On Add/Update |
| --- | --- |
| CustomResourceDefinition, ClusterRole, Role, ClusterRoleBinding, RoleBinding, ConsolePlugin | Converged to the bundle (`convergeToBundle`). A changed (immutable) `roleRef` is skipped and logged. |
| Deployment | Every container (matched by name) gets the bundle's image, plus env vars the bundle defines that the container lacks (`deploymentUpgradeOps`). Existing env values, replicas and resources are never changed. |
| Service, Secret, ConfigMap, PVC, Namespace, others | Left as the cluster has them. |

Supported kinds are `KIND_MODELS` in `src/utils/k8s-models.ts`; `validate-catalog.sh` fails when a bundle uses another kind. CRDs are applied first.

**Installed version:** `installed.json` (written by Add/Update), else the storefront's own `STOREFRONT_VERSION`, else read from the running plugin Deployment's image (`detectInstalledVersion`), so tools installed by hand still get update notifications.

## Storefront self-update

The storefront updates itself like any tool. Its catalog rows point `deployURL` at **`deploy/upgrade.yaml`**: `deploy/install.yaml` without the one-time enable-plugin Job (no storefront can apply a Job) and without the ConfigMaps (the cluster's cache and external tools must never be overwritten). It is generated, never edited by hand:

```bash
python3 scripts/gen-upgrade-yaml.py   # after any change to deploy/install.yaml
```

catalog-service is a companion with its own semver (`oct-storefront-catalog:<semver>-ocp<minor>`); bumping its image in `install.yaml` (and regenerating `upgrade.yaml`) ships it with the next storefront release.

## Releasing (storefront and tools)

1. Tool repo: bump, publish images for **both** minors (never overwrite a published tag), tag `v<semver>`.
2. Storefront: add the tool's `versions[]` rows (keep older rows); regenerate `catalog/deploy/oct-<name>.yaml` from the tool repo when it has a bundle; for a storefront release also bump `package.json` (both fields), `STOREFRONT_VERSION`, add the storefront's **own** rows for both minors, point `install.yaml` at the new tag, run `scripts/gen-upgrade-yaml.py`.
3. `scripts/validate-catalog.sh` must pass (tags public, both minors, bundle kinds supported, storefront self rows, `upgrade.yaml` in sync, storefront rows point at it). quay sometimes returns 502s: rerun before trusting a missing-tag error.
4. Merge, then tag the storefront merge commit `v<semver>` (annotated) and push the tag; rows reference it as `gitRef`.
5. Seed the public API from `octools-stats-worker` (`TOOL=<id> node seed.js`, `DRY_RUN=1` first; the admin token is a Worker secret held by maintainers). Clusters see the release within their 1 h sync window.

## New extension / Add must go Ready

**Add** creates Namespace, ConsolePlugin, and appends `spec.plugins` even when the plugin **never becomes Ready**. **Open** then 404s: href is registered, no plugin bundle (typical: nginx **ImagePullBackOff** / `manifest unknown`).

Before shipping a tile, agents MUST:

1. **Catalog image tag exists and is public.** `spec.versions[].image` (and every sidecar the bundle pulls) must pull anonymously. Community Add has **no pull secret**.
2. **Publish the combined tag the catalog lists.** `<semver>-ocp<major.minor>`. Do not list `:1.1.0` or `:4.22` as the install image. That mismatch is what caused Add-success / Open-404.
3. **Bundle is complete.** Add applies `catalog/deploy/oct-<name>.yaml` (register in `BUNDLED_DEPLOY`) or generated Namespace/Deployment/Service/ConsolePlugin only. Include every PVC, volume, RBAC, Service, and sidecar the Deployments need. **Precreate required PVCs in the bundle** (Add creates them before Deployments). `oct-baremetal` needs PVC `image-cache` (100Gi). Omit `storageClassName` for the cluster default; Add shows a StorageClass dropdown when the YAML has a PVC. Optional PVC annotation `communitytools.io/storage-class` or CommunityTool `spec.storageClassName`.
4. **`spec.href` matches `console-extensions.json`.** `oct-baremetal`: `/baremetal/nodes`. `oct-network-bond`: `/community-tools/network/bond`. `oct-banner`: `/community-tools/management/banner`. `oct-windows-builder`: `/community-tools/compute/windows-builder` unless those routes changed.
5. **Add success is not Ready.** Confirm the plugin Deployment is Running before calling the tile done. For Bare Metal Hosts, also confirm `discovery-service` is Running and `image-cache` is Bound.
6. **Bare Metal Hosts Add** checks Metal3 `Provisioning/provisioning-configuration` `spec.watchAllNamespaces`. If missing/false, the Add dialog warns and can patch `true` with the user’s console token (recommended switch, default on). Do not grant cluster-admin to a plugin ServiceAccount for this.

Canonical checklist: `docs/extension-standard.md`. Do not `oc apply` unless asked.

## No environment-specific hardcoding

Never bake in a lab StorageClass, VLAN, CIDR, hostname, or similar. Omit the field (cluster default), read the live cluster, or use the value chosen at Add. Rule: `.cursor/rules/oct-no-env-hardcoding.mdc`.

## Stats / fail-open

Add / Remove never call the public server. Downloads/ratings: local always; public POST best-effort for community ids.

## PatternFly 6

Import `@patternfly/react-core` ^6. Do not import PatternFly CSS. Prefix CSS `ct-`.

## Verify

```bash
yarn install
yarn build
```
