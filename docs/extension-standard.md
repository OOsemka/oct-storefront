# Extension standard (OpenShift Community Tools)

OCT extensions use **`oct-<name>`** for directories, plugin IDs, images, and catalog `metadata.name` / `spec.consolePlugin`. This is a community project, not Red Hat supported.

Versioning has **two axes**: extension **semver** and **OpenShift minor**. Do not ship only `:4.22` if you also need independent extension releases.

## Git / images

| Axis | Git | Image |
| --- | --- | --- |
| Extension release | tag `v1.2.0` (may sit on `ocp-4.22`) | `:1.2.0` preferred |
| OpenShift minor (PF/API) | branch `ocp-4.22` / `ocp-4.21`; `main` = newest (4.22) | optional `:1.2.0-ocp4.22` when the same semver is rebuilt per OCP |
| PatternFly | PF 6 on 4.22; do not mix PF majors on one branch | |

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
      openshift: ["4.21", "4.22"]
      image: quay.io/example/oct-example-tool:1.0.0
      gitRef: v1.0.0
    - version: "1.1.0"
      channel: stable
      openshift: ["4.22"]
      image: quay.io/example/oct-example-tool:1.1.0
      gitRef: v1.1.0
  minOpenShift: "4.21"
```

Optional `spec.pinVersion: "1.0.0"` (alias: spec `version:`) keeps Add on that semver.

## Add / upgrade (storefront)

| Action | Rule |
| --- | --- |
| Add | Newest stable semver compatible with cluster OCP |
| Pin | `pinVersion` or user pick; no automatic jump |
| Enable | Re-enable plugin; keep existing image |
| Update | Explicit click; patch Deployment; same ConsolePlugin |
| Remove | Disable this plugin only |
| Same ID | Cannot run two semvers at once |

Never auto-update. Never auto-migrate running clusters.

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `metadata.name` | yes | `oct-<name>` stats key |
| `spec.consolePlugin` | yes | ConsolePlugin CR name (`oct-<name>`) |
| `spec.versions` | **yes** (or `validatedOn`) | Each row: `version` (semver), `channel`, `openshift` (string or list), `image` |
| `spec.defaultChannel` | no | Default `stable` |
| `spec.pinVersion` | no | Pin Add to this semver |
| `spec.category` | yes | compute, storage, network, management |
| `spec.source` | yes | `community` in catalog; storefront forces `external` on paste |
| `spec.image` | fallback | Used only if `versions[]` has no image |

## Checklist for a new extension repo

1. Repo / plugin ID / image: `oct-<name>`. Copy `docs/extension-template/`.
2. AGENTS.md + README. Cursor rules: `oct-naming.mdc`, `oct-ocp-versions.mdc`, `oct-semver.mdc`, `oct-docs.mdc`.
3. Tool routes only (no Community Tools four-hub nav). Community disclaimer.
4. PatternFly major matches the OCP branch. No PatternFly CSS import.
5. PR a tile with `spec.versions[]` (semver + openshift) into the storefront `catalog/community.yaml`.
6. `yarn build` in the extension and the storefront. Do not `oc apply` unless asked.
