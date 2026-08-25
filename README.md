# OpenShift Community Tools (OCT storefront)

**Community project. Not officially supported by Red Hat.** Unofficial catalog for OpenShift Console extensions.

This repository is the **storefront**: left-nav **Community Tools** and category hubs (Compute, Storage, Network, Management). Extensions such as Bare Metal Hosts (`oct-baremetal`) and Network Bond (`oct-network-bond`) are separate ConsolePlugins.

- **Plugin ID:** `oct-storefront`
- **OpenShift:** 4.22 (PatternFly 6)
- **Images:** `quay.io/cjanisze/oct-storefront:4.22` and `quay.io/cjanisze/oct-storefront-catalog:4.22` (public)

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
2. Publish **public** container images (see below) and list them on `spec.versions[].image`.
3. Open a PR against [`catalog/community.yaml`](catalog/community.yaml) in this repo.

Catalog fields, semver × OpenShift minors, and Add/Update rules: [docs/extension-standard.md](docs/extension-standard.md).

### Public images (required)

Every catalog `spec.versions[].image` — and any related discovery or sidecar image the extension pulls — must be **public** (for example a public Quay repository).

Private images break `oc apply` and tile **Add** on other clusters: those clusters cannot pull your image. Do not ship a catalog tile that points at a private repo.

## Quick start (developers)

```bash
yarn install
yarn build
```
