# Extension standard (OpenShift Community Tools)

OCT extensions use **`oct-<name>`** for directories, plugin IDs, images, and catalog `metadata.name` / `spec.consolePlugin`. This is a community project, not Red Hat supported.

Versioning has **two axes in the catalog**: extension **semver** and **OpenShift minor**. Do not collapse the catalog into a single `:4.22` tag. **Image tags MUST encode both axes**: `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). Catalog `versions[].image` must be that **exact combined tag**, public, and present on the registry.

## Add must go Ready (required)

Storefront **Add** applies YAML, then appends `consoles.operator.openshift.io/cluster` `spec.plugins`. It does **not** wait for the ConsolePlugin to become Ready.

If the nginx plugin image cannot be pulled, Add still reports success, tile **Open** is enabled, and Console **404s** (href registered, no plugin bundle — typically **ImagePullBackOff** / `manifest unknown`).

Before a tile ships, satisfy **all** of:

1. **Image tag exists and is public.** Every `spec.versions[].image` and every sidecar/discovery image the bundle pulls must pull **anonymously**. Community Add and community `oc apply` have **no pull secret**. A missing tag (`manifest unknown`) is a ship-blocker.
2. **Publish the combined tag the catalog lists.** Tag format is `<semver>-ocp<major.minor>` (not `ocp4.22-1.0.1`, not bare `:1.1.0`, not bare `:4.22`). Never list a catalog row for (version, OpenShift minor) unless that exact tag exists and is public. That is what caused Add-success / Open-404 (`:1.1.0` cataloged, only `:4.22` published). Bare `:4.22` / `:1.1.0` may remain as extra aliases.
3. **Install bundle is complete.** Add resolves YAML in this order: `versions[].deployYAML` → storefront `catalog/deploy/oct-<name>.yaml` (also register the import in `BUNDLED_DEPLOY` in `src/utils/catalog-actions.ts`) → `deployURL` → generated Namespace + plugin Deployment + Service + ConsolePlugin. Generated YAML does **not** include extra PVCs, RBAC, or sidecars. Put every required volume, PVC, Service, ServiceAccount, and RBAC in the bundled YAML. **Required PVCs must be in the bundle** so Add creates them **before** Deployments (pods that mount a missing PVC stay Pending). Not every extension needs a PVC; every volume a Deployment mounts must be in the bundle Add applies. `oct-baremetal` precreates `image-cache` (100Gi).
4. **StorageClass:** Omit `spec.storageClassName` on PVCs to use the **cluster default**. Add shows a StorageClass dropdown when the bundle contains a PVC (default = cluster default). Authors can also set PVC annotation `communitytools.io/storage-class` or CommunityTool `spec.storageClassName` as the Add default. `storageClassName` is immutable after the PVC is Bound. Do not hardcode a lab StorageClass in the bundle.
5. **Bare Metal Hosts Add:** Check `provisioning.metal3.io/provisioning-configuration` `spec.watchAllNamespaces`. If missing/false, Add shows a warning and a recommended switch (default on) that patches `true` with the **user’s console credentials**. Unchecking still installs the plugin but warns. If the patch is forbidden, show the error and `oc patch provisioning.metal3.io provisioning-configuration --type=merge -p '{"spec":{"watchAllNamespaces":true}}'`. Do **not** grant cluster-admin to a plugin ServiceAccount for this. Inventory shows the same warning as a safety net when hosts exist outside `openshift-machine-api`.
6. **Kinds Add can create:** Namespace, Deployment, Service, ServiceAccount, Secret, ConfigMap, PersistentVolumeClaim, Role, RoleBinding, ClusterRole, ClusterRoleBinding, ConsolePlugin, Route. Other kinds fail Add. Add sorts PVCs before Deployments.
7. **`spec.href` matches plugin routes.** Tile **Open** uses `spec.href`. It must be a path registered in the extension `console-extensions.json`. Current: `oct-baremetal` → `/baremetal/nodes`; `oct-network-bond` → `/community-tools/network/bond` unless those routes changed.
8. **Add success is not done.** Confirm the plugin Deployment is Running (and any sidecars) before calling the extension shippable. For Bare Metal Hosts, also confirm `discovery-service` is Running and PVC `image-cache` is Bound.

## Public images (required)

Every `spec.versions[].image` — and any related discovery or sidecar image the extension pulls — must be **public** (for example a public Quay repository) **and the listed combined tag must exist**. Private or missing tags break `oc apply` and tile **Add** on other clusters. Do not publish a catalog tile that points at a private repo or an unpublished tag.

If one semver supports multiple OpenShift minors with the **same** bits, publish **two tags on the same digest** (`1.1.0-ocp4.21` and `1.1.0-ocp4.22`), not one ambiguous `:1.1.0` as the only catalog image. Prefer one `versions[]` row per (semver, OCP minor) so `image` is the exact combined tag.

## Git / images

| Axis | Git | Image |
| --- | --- | --- |
| Extension release | tag `v1.2.0` (may sit on `ocp-4.22`) | `:1.2.0-ocp4.22` (required in catalog) |
| OpenShift minor (PF/API) | branch `ocp-4.22` / `ocp-4.21`; `main` = newest (4.22) | suffix `-ocp4.22` / `-ocp4.21` on the same semver |
| PatternFly | PF 6 on 4.22; do not mix PF majors on one branch | |
| Aliases | | optional extra `:1.2.0` and `:4.22` if already published |

## CommunityTool template

```yaml
apiVersion: communitytools.io/v1alpha1
kind: CommunityTool
metadata:
  name: oct-example-tool
spec:
  displayName: Example Tool
  description: One or two sentences. Do not claim Red Hat support.
  category: network   # compute | storage | network | management
  source: community
  git: https://github.com/example/oct-example-tool
  consolePlugin: oct-example-tool
  href: /example-tool
  defaultChannel: stable
  channels:
    stable: {}
    candidate: {}
  versions:
    - version: "1.0.0"
      channel: stable
      openshift: ["4.21"]
      image: quay.io/example/oct-example-tool:1.0.0-ocp4.21
      gitRef: v1.0.0
    - version: "1.0.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-example-tool:1.0.0-ocp4.22
      gitRef: v1.0.0
    - version: "1.1.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-example-tool:1.1.0-ocp4.22
      gitRef: v1.1.0
  minOpenShift: "4.21"
```

Optional `spec.pinVersion: "1.0.0"` (alias: spec `version:`) keeps Add on that semver (the row whose `openshift` includes the cluster).

## Add / upgrade (storefront)

| Action | Rule |
| --- | --- |
| Add | One-click: newest stable semver compatible with cluster OCP. **Choose version** when multiple compatible semvers exist. |
| Pin | `pinVersion` is the Add default; the user can still pick another compatible semver |
| Enable | Re-enable plugin; keep existing image |
| Update | Explicit click to newest compatible; tile shows “Update available” |
| Change version | Explicit picker (including older compatible semvers); same ConsolePlugin |
| Remove | Disable this plugin only |
| Same ID | Cannot run two semvers at once |

Never auto-update. Never auto-migrate running clusters.

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `metadata.name` | yes | `oct-<name>` stats key |
| `spec.consolePlugin` | yes | ConsolePlugin CR name (`oct-<name>`) |
| `spec.href` | yes (for Open) | Must match a `console-extensions.json` route |
| `spec.versions` | **yes** (or `validatedOn`) | Each row: `version` (semver), `channel`, `openshift`, `image` (`<semver>-ocp<minor>`, **public**, **tag exists**) |
| `spec.defaultChannel` | no | Default `stable` |
| `spec.pinVersion` | no | Pin Add to this semver |
| `spec.storageClassName` | no | Add UI default StorageClass for PVCs in the bundle. Empty/omitted = cluster default. Same effect as PVC annotation `communitytools.io/storage-class`. |
| `spec.category` | yes | compute, storage, network, management |
| `spec.source` | yes | `community` in catalog; storefront forces `external` on paste |
| `spec.image` | fallback | Used only if `versions[]` has no image; must still be a combined tag |

## Checklist for a new extension repo

1. Repo / plugin ID / image: `oct-<name>`. Copy `docs/extension-template/`.
2. AGENTS.md + README. Cursor rules: `oct-naming.mdc`, `oct-ocp-versions.mdc`, `oct-semver.mdc`, `oct-docs.mdc`, `oct-extension-add.mdc` (`alwaysApply: true`).
3. Tool routes only (no Community Tools four-hub nav). Community disclaimer.
4. PatternFly major matches the OCP branch. No PatternFly CSS import.
5. PR a tile into storefront `catalog/community.yaml` with `spec.versions[]` (`version`, `channel`, `openshift`, **public combined** `image` whose **tag exists**). Set `spec.href` to a `console-extensions.json` route.
6. If the plugin needs more than Namespace/Deployment/Service/ConsolePlugin, add `catalog/deploy/oct-<name>.yaml` (complete volumes/RBAC/Services **and required PVCs**) and register it in `BUNDLED_DEPLOY`. Omit PVC `storageClassName` for the cluster default; Add can override.
7. `yarn build` in the extension and the storefront. Do not treat storefront **Add** success as Ready — confirm the plugin Deployment is Running. Do not `oc apply` unless asked.
