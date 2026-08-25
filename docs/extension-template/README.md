# OCT extension template

Copy this directory into a new repo named **`oct-<name>`**.

This is OpenShift Community Tools (OCT), a **community project**, not officially supported by Red Hat.

## Required identifiers

- Directory / git repo: `oct-<name>`
- `package.json` `consolePlugin.name`: `oct-<name>`
- ConsolePlugin CR and namespace: `oct-<name>`
- Image: `quay.io/<org>/oct-<name>:1.2.0-ocp4.22` (`<semver>-ocp<major.minor>`) — **must be public; the tag must exist**. Optional aliases `:1.2.0` / `:4.22`.
- i18n: `locales/en/plugin__oct-<name>.json`
- Tile `spec.href`: a path from this plugin's `console-extensions.json`

Copy `.cursor/rules/` from this template (or from `oct-storefront`) unchanged, including **`oct-extension-add.mdc`**.

## Add must go Ready

Storefront **Add** can succeed (Namespace, ConsolePlugin, `spec.plugins`) while the plugin never becomes Ready. **Open** then 404s (no bundle; typical **ImagePullBackOff**).

Requirements (canonical: `../../docs/extension-standard.md`):

- Catalog `versions[].image` tag **exists**, is **public** (no pull secret), and is the **combined** tag `<semver>-ocp<major.minor>`.
- Never list a (version, OpenShift minor) row unless that exact tag is public. Do not catalog `:1.2.0` if only `:4.22` exists.
- If the plugin needs more than Namespace/Deployment/Service/ConsolePlugin, ship a complete bundle in storefront `catalog/deploy/oct-<name>.yaml` (every PVC, volume, RBAC, Service) and register it in `BUNDLED_DEPLOY`.
- Confirm the plugin Deployment is Running before calling Add done.

## Public images (required)

Catalog `spec.versions[].image` and any discovery/sidecar images must be **public** (for example a public Quay repository) **and the listed combined tag must exist**. Private or unpublished tags break `oc apply` and tile **Add** on other clusters.

## Versioning

Two axes in the catalog: **semver** (`v1.2.0`) and **OpenShift minor** (`ocp-4.22` when PF/API differ). Image tags always encode both (`1.2.0-ocp4.22`, not `ocp4.22-1.2.0`). Storefront Add picks the newest stable semver compatible with the cluster; it never auto-upgrades an existing install.

## Checklist

See `../../docs/extension-standard.md` and keep AGENTS.md + README in the new repo.
