# AGENTS.md — OCT extension (`oct-<name>`)

Community project. Not officially supported by Red Hat.

- Plugin ID / ConsolePlugin / image: **`oct-<name>`**
- Do not register Community Tools nav. Tool routes only.
- **Two version axes in the catalog:** git tag `v1.2.0` (semver) and optional `ocp-X.Y` branch for PF/API. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `oct-<name>:1.2.0-ocp4.22`). Never catalog `:1.2.0` or `:4.22` as the install image unless that exact combined tag exists and is public.
- Catalog PR: `oct-storefront` `catalog/community.yaml` with `spec.versions[]` (`version`, `channel`, `openshift`, combined `image`). **Images must be public and the listed tag must exist.** Private or unpublished tags break tile Add. `spec.href` must match a `console-extensions.json` route. Optional `spec.icon: tiles/oct-<name>.svg` (SVG in storefront `src/assets/tiles/`, registered in `tile-icons.ts`; same field in `deploy/install.yaml`).
- **Add must go Ready:** storefront Add can succeed while the plugin never becomes Ready (Open 404 / ImagePullBackOff). Bundle every required PVC, volume, RBAC, and Service in `catalog/deploy/oct-<name>.yaml` so Add **precreates** PVCs before Deployments. Omit PVC `storageClassName` for the cluster default; Add shows a StorageClass picker. Confirm the plugin Deployment is Running. Canonical: storefront `docs/extension-standard.md`. Bare Metal Hosts Add also checks Metal3 `watchAllNamespaces`.
- Add installs newest stable compatible semver. Update is explicit. One ConsolePlugin name = one running version.
- PatternFly major matches the OCP branch. No PatternFly CSS import.
- Disclaimer: “Community project. Not officially supported by Red Hat.”
- `yarn build`. Do not `oc apply` unless asked.
- **No environment-specific hardcoding:** never bake in a lab StorageClass, VLAN, CIDR, hostname, or similar. Omit for cluster default, read the cluster, or use the Add-time choice. Copy `.cursor/rules/oct-no-env-hardcoding.mdc`.

Copy `.cursor/rules/oct-naming.mdc`, `oct-ocp-versions.mdc`, `oct-semver.mdc`, `oct-docs.mdc`, `oct-extension-add.mdc`, `oct-no-env-hardcoding.mdc`.
