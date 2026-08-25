# OCT extension template

Copy this directory into a new repo named **`oct-<name>`**.

This is OpenShift Community Tools (OCT), a **community project**, not officially supported by Red Hat.

## Required identifiers

- Directory / git repo: `oct-<name>`
- `package.json` `consolePlugin.name`: `oct-<name>`
- ConsolePlugin CR and namespace: `oct-<name>`
- Image: `quay.io/<org>/oct-<name>:1.2.0` (semver; optional `:1.2.0-ocp4.22`) — **must be public**
- i18n: `locales/en/plugin__oct-<name>.json`

Copy `.cursor/rules/` from this template (or from `oct-storefront`) unchanged.

## Public images (required)

Catalog `spec.versions[].image` and any discovery/sidecar images must be **public** (for example a public Quay repository). Private images break `oc apply` and tile **Add** on other clusters.

## Versioning

Two axes: **semver tags** (`v1.2.0`) and **OpenShift minors** (`ocp-4.22` when PF/API differ). Catalog tile must list both in `spec.versions[]` — see `catalog-tool.yaml`. Storefront Add picks the newest stable semver compatible with the cluster; it never auto-upgrades an existing install.

## Checklist

See `../../docs/extension-standard.md` and keep AGENTS.md + README in the new repo.
