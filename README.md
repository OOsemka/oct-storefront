# OpenShift Community Tools (OCT storefront)

**Community project. Not officially supported by Red Hat.** Unofficial catalog for OpenShift Console extensions.

## Install (one command)

Cluster-admin. Images are **public** on `quay.io/cjanisze`. No pull secret.

```bash
oc apply -f https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/install.yaml
```

Then **hard-refresh** the OpenShift Console (Ctrl+Shift+R on Linux/Windows, Cmd+Shift+R on macOS). Dynamic plugins are cached; a normal reload is often not enough.

You should see **Community Tools** in the Administrator left nav, with **Compute**, **Storage**, **Network**, and **Management** hubs. Use **Add** on a tile to install that extension. This apply installs **only** the storefront; it does **not** install `oct-baremetal` or `oct-network-bond`.

Wait until both Deployments are Ready (optional):

```bash
oc rollout status deploy/oct-storefront -n oct-storefront
oc rollout status deploy/catalog-service -n oct-storefront
oc wait --for=condition=complete job/oct-storefront-enable-plugin -n oct-storefront --timeout=120s
```

- **Plugin ID:** `oct-storefront`
- **Image:** `quay.io/cjanisze/oct-storefront:4.22` (public)
- **Catalog image:** `quay.io/cjanisze/oct-storefront-catalog:4.22` (public)
- **Git:** tags `v1.x.x`; `main` tracks newest OCP (4.22); optional `ocp-X.Y` branch per OpenShift minor

This repo is the **storefront** (left-nav **Community Tools** and category hubs). Extensions are separate ConsolePlugins (`oct-baremetal`, `oct-network-bond`).

## Quick start (developers)

```bash
yarn install
yarn build
```

## What the apply creates

That single apply creates namespace `oct-storefront`, the plugin and catalog-service Deployments/Services, RBAC, ConsolePlugin `oct-storefront`, the bundled catalog ConfigMap, and a Job that enables the plugin on the cluster console.

Job `oct-storefront-enable-plugin` adds `oct-storefront` to `consoles.operator.openshift.io/cluster` `spec.plugins` if it is missing. It is a no-op when the name is already present. It does not remove kubevirt, monitoring, or any other plugin.

Edit the image refs in `deploy/install.yaml` first if you use a different org or tag.

Old plugin ID `openshift-community-tools` is retired. A cluster that still has that ID needs a reinstall (remove it from `spec.plugins`, delete the old namespace, then install `oct-storefront` as above).

See [AGENTS.md](AGENTS.md) and [docs/extension-standard.md](docs/extension-standard.md) for the two-axis catalog (`version` semver × `openshift` minors) and Add/Update rules.

## Appendix: troubleshooting

### Private images / ImagePullBackOff

Happy-path install expects **public** Quay repositories. If pods cannot pull:

1. Open [quay.io/cjanisze/oct-storefront](https://quay.io/repository/cjanisze/oct-storefront)
2. **Repository Settings → Make Public**
3. Repeat for [oct-storefront-catalog](https://quay.io/repository/cjanisze/oct-storefront-catalog)

Alternatively, keep the images private and put Quay credentials in the **cluster global pull secret** (`openshift-config` / `pull-secret`). Do not create a per-namespace `quay-cjanisze` secret for install.

### Enable-plugin Job

```bash
oc logs job/oct-storefront-enable-plugin -n oct-storefront
oc get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}{"\n"}'
```

If a previous Job failed and you need it to run again:

```bash
oc delete job oct-storefront-enable-plugin -n oct-storefront
oc apply -f https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/install.yaml
```
