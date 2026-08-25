# OpenShift Community Tools — storefront (catalog)

This repository is the **OCT storefront**: catalog hubs only.
**Community project. Not officially supported by Red Hat.**

Directory (preferred): `oct-storefront`. Plugin ID: **`oct-storefront`**.

## Modules

| Directory | Plugin ID | Image tags |
| --- | --- | --- |
| **oct-storefront** (this) | `oct-storefront` | `:1.x.x` (semver); optional `:1.x.x-ocp4.22` if rebuilt per OCP |
| oct-baremetal | `oct-baremetal` | same |
| oct-network-bond | `oct-network-bond` | same |

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

1. **Extension semver** (`versions[].version`, git tag `v1.2.0`, image `:1.2.0`)
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
      openshift: ["4.21", "4.22"]
      image: quay.io/example/oct-my-tool:1.1.0
      gitRef: v1.1.0
    - version: "1.2.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-my-tool:1.2.0
      gitRef: v1.2.0
```

Every `versions[].image` (and any discovery/sidecar image the extension pulls) must be **public** and the **listed tag must exist**. Private or unpublished tags break tile Add on other clusters. `spec.href` must match a `console-extensions.json` route.

Legacy rows (`openshift: "4.22"` without `version`) still parse.

`validatedOn` is derived from `versions[].openshift` when omitted. Alias: `spec.compatibility.openshift`. Spec-level `version:` is accepted as `pinVersion`.

## Add / Enable / Update / Remove

| Action | Behavior |
| --- | --- |
| **Add** (not installed) | Newest **stable** semver whose `openshift` list includes the cluster (`ClusterVersion` / `window.SERVER_FLAGS`). Unknown cluster → user pick. Never pick an OCP-incompatible row when cluster minor is known. |
| **Pin** | `spec.pinVersion` (or spec `version:`) or an explicit pick. That semver stays; 1.2.0 is not applied automatically. |
| **Enable** | Re-enables `spec.plugins`. **Does not** change the Deployment image. |
| **Update** | Explicit click. Same ConsolePlugin name; patches the plugin Deployment image. Never auto. Tile shows installed vs newer compatible (“Update available”). |
| **Remove** | Disables this plugin only. Leaves Deployment. Does not uninstall other tools or other pinned plugins. |
| **Same plugin ID** | One ConsolePlugin name = **one running version**. 1.2 does not run beside 1.1 under the same ID. Legacy stays on 1.1 by **not** clicking Update. |

Git: tags `v1.2.0`; optional `ocp-4.22` branch for PF/API. A `v1.2.0` tag can live on `ocp-4.22`. Images prefer `:1.2.0`; use `:1.2.0-ocp4.22` when the same semver is rebuilt per OCP. Do not auto-migrate running clusters.

## New extension / Add must go Ready

**Add** creates Namespace, ConsolePlugin, and appends `spec.plugins` even when the plugin **never becomes Ready**. **Open** then 404s: href is registered, no plugin bundle (typical: nginx **ImagePullBackOff** / `manifest unknown`).

Before shipping a tile, agents MUST:

1. **Catalog image tag exists and is public.** `spec.versions[].image` (and every sidecar the bundle pulls) must pull anonymously. Community Add has **no pull secret**.
2. **Publish the semver tag the catalog lists.** Two axes: extension `:1.1.0` vs OpenShift `:4.22`. Do not list `:1.1.0` if only `:4.22` exists. Prefer publishing `:1.1.0` (keep the OCP tag if used).
3. **Bundle is complete.** Add applies `catalog/deploy/oct-<name>.yaml` (register in `BUNDLED_DEPLOY`) or generated Namespace/Deployment/Service/ConsolePlugin only. Include every PVC, volume, RBAC, Service, and sidecar the Deployments need.
4. **`spec.href` matches `console-extensions.json`.** `oct-baremetal`: `/baremetal/nodes`. `oct-network-bond`: `/community-tools/network/bond` unless those routes changed.
5. **Add success is not Ready.** Confirm the plugin Deployment is Running before calling the tile done.

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
