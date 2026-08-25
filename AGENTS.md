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

This webpack bundle must **not** contain extension pages. Hubs list tiles; **Open** goes to the extension plugin. Do not rename plugin ID `oct-storefront` (breaking install). Do not `oc apply` unless asked.

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

Keep two axes in the catalog. Image tags always encode both: `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). Not `ocp4.22-1.0.1`.

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

Legacy rows (`openshift: "4.22"` without `version`) still parse.

`validatedOn` is derived from `versions[].openshift` when omitted. Alias: `spec.compatibility.openshift`. Spec-level `version:` is accepted as `pinVersion`.

## Add / Enable / Update / Remove

| Action | Behavior |
| --- | --- |
| **Add** (not installed) | Newest **stable** semver whose `openshift` list includes the cluster. One-click Add uses that default. **Choose version** (when more than one compatible semver exists) opens a picker, latest selected. Unknown cluster → user pick. Never pick an OCP-incompatible row when cluster minor is known. |
| **Pin** | `spec.pinVersion` (or spec `version:`) is the Add **default**, not a lock. The user can still pick another compatible semver. |
| **Enable** | Re-enables `spec.plugins`. **Does not** change the Deployment image. |
| **Update** | Explicit click to the newest compatible semver. Never auto. Tile shows “Update available (x.y.z)”. |
| **Change version** | Explicit picker of any compatible semver (including older). Same ConsolePlugin name; one running version. |
| **Remove** | Disables this plugin only. Leaves Deployment. Does not uninstall other tools or other pinned plugins. |
| **Same plugin ID** | One ConsolePlugin name = **one running version**. 1.2 does not run beside 1.1 under the same ID. Legacy stays on 1.1 by **not** clicking Update. |

Git: tags `v1.2.0`; optional `ocp-4.22` branch for PF/API. A `v1.2.0` tag can live on `ocp-4.22`. Images in catalog and install YAML are `:1.2.0-ocp4.22`. Same bits on two minors → two tags on one digest. Do not auto-migrate running clusters.

## New extension / Add must go Ready

**Add** creates Namespace, ConsolePlugin, and appends `spec.plugins` even when the plugin **never becomes Ready**. **Open** then 404s: href is registered, no plugin bundle (typical: nginx **ImagePullBackOff** / `manifest unknown`).

Before shipping a tile, agents MUST:

1. **Catalog image tag exists and is public.** `spec.versions[].image` (and every sidecar the bundle pulls) must pull anonymously. Community Add has **no pull secret**.
2. **Publish the combined tag the catalog lists.** `<semver>-ocp<major.minor>`. Do not list `:1.1.0` or `:4.22` as the install image. That mismatch is what caused Add-success / Open-404.
3. **Bundle is complete.** Add applies `catalog/deploy/oct-<name>.yaml` (register in `BUNDLED_DEPLOY`) or generated Namespace/Deployment/Service/ConsolePlugin only. Include every PVC, volume, RBAC, Service, and sidecar the Deployments need. **Precreate required PVCs in the bundle** (Add creates them before Deployments). `oct-baremetal` needs PVC `image-cache` (100Gi). Omit `storageClassName` for the cluster default; Add shows a StorageClass dropdown when the YAML has a PVC. Optional PVC annotation `communitytools.io/storage-class` or CommunityTool `spec.storageClassName`.
4. **`spec.href` matches `console-extensions.json`.** `oct-baremetal`: `/baremetal/nodes`. `oct-network-bond`: `/community-tools/network/bond` unless those routes changed.
5. **Add success is not Ready.** Confirm the plugin Deployment is Running before calling the tile done. For Bare Metal Hosts, also confirm `discovery-service` is Running and `image-cache` is Bound.
6. **Bare Metal Hosts Add** checks Metal3 `Provisioning/provisioning-configuration` `spec.watchAllNamespaces`. If missing/false, the Add dialog warns and can patch `true` with the user’s console token (recommended switch, default on). Do not grant cluster-admin to a plugin ServiceAccount for this.

Canonical checklist: `docs/extension-standard.md`. Do not `oc apply` unless asked.

## Stats / fail-open

ConfigMaps `community-tools-cache` (includes `installed.json`) and `community-tools-external` in namespace **`oct-storefront`**. Proxy: `/api/proxy/plugin/oct-storefront/catalog-service`.

Add / Remove never call the public server. Downloads/ratings: local always; public POST best-effort for community ids.

## PatternFly 6

Import `@patternfly/react-core` ^6. Do not import PatternFly CSS. Prefix CSS `ct-`.

## Verify

```bash
yarn install
yarn build
```
