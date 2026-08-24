# AGENTS.md — OCT extension (`oct-<name>`)

Community project. Not officially supported by Red Hat.

- Plugin ID / ConsolePlugin / image: **`oct-<name>`**
- Do not register Community Tools nav. Tool routes only.
- **Two version axes:** git tag `v1.2.0` (semver) and optional `ocp-X.Y` branch for PF/API. Images `oct-<name>:1.2.0` (optional `:1.2.0-ocp4.22`).
- Catalog PR: `oct-storefront` `catalog/community.yaml` with `spec.versions[]` (`version`, `channel`, `openshift`, `image`).
- Add installs newest stable compatible semver. Update is explicit. One ConsolePlugin name = one running version.
- PatternFly major matches the OCP branch. No PatternFly CSS import.
- Disclaimer: “Community project. Not officially supported by Red Hat.”
- `yarn build`. Do not `oc apply` unless asked.

Copy `.cursor/rules/oct-naming.mdc`, `oct-ocp-versions.mdc`, `oct-semver.mdc`, `oct-docs.mdc`.
