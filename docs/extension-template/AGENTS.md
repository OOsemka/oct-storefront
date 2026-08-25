# AGENTS.md — OCT extension (`oct-<name>`)

Community project. Not officially supported by Red Hat.

- Plugin ID / ConsolePlugin / image: **`oct-<name>`**
- Do not register Community Tools nav. Tool routes only.
- **Two version axes:** git tag `v1.2.0` (semver) and optional `ocp-X.Y` branch for PF/API. Images `oct-<name>:1.2.0` (optional `:1.2.0-ocp4.22`). Publish the semver tag the catalog lists; do not catalog `:1.2.0` if only `:4.22` exists.
- Catalog PR: `oct-storefront` `catalog/community.yaml` with `spec.versions[]` (`version`, `channel`, `openshift`, `image`). **Images must be public and the listed tag must exist.** Private or unpublished tags break tile Add. `spec.href` must match a `console-extensions.json` route.
- **Add must go Ready:** storefront Add can succeed while the plugin never becomes Ready (Open 404 / ImagePullBackOff). Bundle every required PVC, volume, RBAC, and Service in `catalog/deploy/oct-<name>.yaml`. Confirm the plugin Deployment is Running. Canonical: storefront `docs/extension-standard.md`.
- Add installs newest stable compatible semver. Update is explicit. One ConsolePlugin name = one running version.
- PatternFly major matches the OCP branch. No PatternFly CSS import.
- Disclaimer: “Community project. Not officially supported by Red Hat.”
- `yarn build`. Do not `oc apply` unless asked.

Copy `.cursor/rules/oct-naming.mdc`, `oct-ocp-versions.mdc`, `oct-semver.mdc`, `oct-docs.mdc`, `oct-extension-add.mdc`.
