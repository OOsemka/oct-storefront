# OpenShift Community Tools (OCT storefront)

**Community project. Not officially supported by Red Hat.** Unofficial catalog for OpenShift Console extensions.

This repository is the **storefront**: left-nav **Community Tools** and category hubs (Compute, Storage, Network, Management). Extensions such as Bare Metal Hosts (`oct-baremetal`) and Network Bond (`oct-network-bond`) are separate ConsolePlugins.

- **Plugin ID:** `oct-storefront`
- **OpenShift:** 4.22 (PatternFly 6)
- **Images:** `quay.io/cjanisze/oct-storefront:1.0.0-ocp4.22` and `quay.io/cjanisze/oct-storefront-catalog:1.0.0-ocp4.22` (public; `:4.22` remains as an alias)

## Install (one command)

Cluster-admin.

```bash
oc apply -f https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/install.yaml
```

Then:

1. **Hard-refresh** the OpenShift Console (Ctrl+Shift+R on Linux/Windows, Cmd+Shift+R on macOS). Dynamic plugins are cached; a normal reload is often not enough.
2. Open **Community Tools** in the Administrator left nav.
3. Use **Add** on a tile to install that extension.

This apply installs **only** the storefront. It does **not** install `oct-baremetal` or `oct-network-bond`.

## Add an extension

1. Copy [`docs/extension-template/`](docs/extension-template/) into a new repo named `oct-<name>`.
2. Publish **public** container images whose tags are `<semver>-ocp<major.minor>` (for example `:1.1.0-ocp4.22`) and list those exact tags on `spec.versions[].image`. Do not catalog `:1.1.0` if only `:4.22` exists. Bare `:4.22` / `:1.1.0` may stay as extra aliases.
3. Set `spec.href` to a route from the extension `console-extensions.json`. If Add needs more than Namespace/Deployment/Service/ConsolePlugin, put the full YAML in `catalog/deploy/oct-<name>.yaml` — including **every required PVC** (created before Deployments). Omit PVC `storageClassName` to use the cluster default; Add lets the installer pick a StorageClass. Optional CommunityTool `spec.storageClassName` or PVC annotation `communitytools.io/storage-class`.
4. Open a PR against [`catalog/community.yaml`](catalog/community.yaml) in this repo.

**Add can succeed while the plugin never becomes Ready** (Open then 404s). Confirm the plugin Deployment is Running. Canonical checklist: [docs/extension-standard.md](docs/extension-standard.md).

### Public images (required)

Every catalog `spec.versions[].image` — and any related discovery or sidecar image the extension pulls — must be **public** (for example a public Quay repository) **and the listed combined tag must exist**.

Private or unpublished tags break `oc apply` and tile **Add** on other clusters: those clusters cannot pull your image. Community Add has no pull secret. Do not ship a catalog tile that points at a private repo or a tag that was never published.

## Quick start (developers)

```bash
yarn install
yarn build
```
