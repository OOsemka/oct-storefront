# OCT security model

This page explains how Community Tools thinks about security, what is enforced today, and what is advisory. It is the reference for contributors, cluster admins and reviewers. The full proposal is in [rfc-security-framework.md](rfc-security-framework.md).

## What can go wrong

OCT installs community extensions into a cluster with the clicking user's credentials, which in practice is a cluster admin. An extension can therefore bring:

- **RBAC**: ClusterRoles bound cluster-wide. These may include reading every Secret, exec into any pod, creating workloads anywhere, or changing RBAC.
- **Privileged runtime access**: SCC use, host networking or paths, added Linux capabilities.
- **Network exposure**: a Route that publishes a backend outside the cluster, or a backend reachable by any pod.
- **A backend** behind the console proxy that acts with its own ServiceAccount on behalf of whoever calls it.
- **Images** from any registry, by mutable tag.

The model below makes these visible, lets admins set limits, and gives contributors a clear way to say what their extension needs and why.

## Declare → Derive → Decide

1. **Declare.** A contributor may describe what the extension needs in `spec.security` (see [extension-standard.md](extension-standard.md)). This is intent plus a reason per permission. It is optional: a missing declaration shows as "Not declared".
2. **Derive.** The storefront (at install time) and CI (at pull-request time) compute the **actual** profile from the manifests that would really be applied. The code is the same in both places: `src/utils/security-profile.ts`. **The derived profile is the source of truth**, so a missing or wrong declaration can never hide what a bundle does.
3. **Decide.** A cluster-admin policy is evaluated against the derived profile: allow, warn, review or block, with the reasons shown.

## Privilege levels

Every bundle gets a derived level, the highest that applies:

| Level | Meaning |
|---|---|
| `plugin` | Only the console plugin (Namespace, Deployment, Service, ConsolePlugin, ConfigMap). |
| `namespaced` | Also a ServiceAccount, Role/RoleBinding, PVC or Secret in its own namespace. A ClusterRole bound by a RoleBinding counts here. |
| `cluster-read` | Also CRDs, or ClusterRoles bound cluster-wide with only get/list/watch, excluding Secrets. |
| `cluster-write` | Cluster-wide write verbs. |
| `privileged` | Any of: SCC use or definition, hostNetwork/hostPID/hostIPC/hostPath, privileged containers, added capabilities, RBAC wildcards, escalate/bind/impersonate, cluster-wide Secret read, cluster-wide pods/exec, cluster-wide workload creation, cluster-wide RBAC writes, Node writes, or a cluster-wide binding to cluster-admin/admin/edit. |

**A ClusterRole defined but not bound in the bundle is treated as cluster-wide**, because it may be bound at runtime.

## Findings

Besides the level, the profile lists findings, each with a stable id:

| Area | Finding ids |
|---|---|
| RBAC | `rbac-wildcard`, `rbac-escalate`, `rbac-bind`, `rbac-impersonate`, `rbac-cluster-secrets-read`, `rbac-cluster-pods-exec`, `rbac-cluster-workload-create`, `rbac-cluster-rbac-write`, `rbac-cluster-nodes-write`, `rbac-cluster-namespaces-delete`, `rbac-binds-cluster-admin`, `rbac-binds-builtin-*`, `rbac-binds-external-role`, `rbac-unbound-clusterrole` |
| SCC and host access | `scc-use`, `scc-defined`, `host-hostNetwork`, `host-hostPID`, `host-hostIPC`, `host-path`, `container-privileged`, `capability-*` |
| Network | `route-exposed`, `route-exposed-plain-http`, `service-exposed`, `backend-no-networkpolicy` |
| Backend identity | `proxy-no-user-token` (the ConsolePlugin proxy doesn't forward the user's identity with `authorization: UserToken`) |
| Secrets | `secret-with-data` (credentials shipped inside the bundle) |
| Images | `image-mutable-tag` (no tag or `:latest`) |
| Hardening (info only) | `workload-hardening` (missing allowPrivilegeEscalation: false / readOnlyRootFilesystem: true / non-root) |

## CI: report and ratchet

`yarn security-check` derives the profile of every bundle in `catalog/deploy/` and compares the findings with [`catalog/security-baseline.json`](../catalog/security-baseline.json):

- Findings already in the baseline are **tolerated**. They are the known issues of existing tools.
- **New** findings are reported. With `--strict`, CI fails on them.
- When a tool is fixed, the report lists findings that are "no longer present". Remove them from the baseline with `yarn security-check --update-baseline` and review the diff.

The goal is an empty baseline. Besides the ratchet, two **hard rules** fail CI for any new occurrence:

- a Secret with data inside a bundle;
- a catalog row whose inline `deployYAML` contains a NetworkPolicy without `versions[].minStorefront: "1.6.0"` or newer.

The report also warns when a declaration understates the bundle (declared level below the derived one, or a Route not listed in `spec.security.network.routes`) and lists tools with no declaration.

`yarn check-repo`, which every OCT repository runs, warns on risky patterns in source and manifests: CORS `*` in shipped config, disabled TLS verification, `chmod 777`, `sh -c` in Go, `:latest` images, deploy URLs on `main`, RBAC wildcards, and code that creates SCCs. `CHECK_REPO_SECURITY=error` turns the warnings into failures.

## Cluster policy

Cluster admins can tune what the storefront offers with the optional ConfigMap `community-tools-policy` (namespace `oct-storefront`, key `policy.yaml`). The storefront never creates it, so **no policy means the defaults**. A commented copy with every setting at its default is in [`deploy/policy/`](../deploy/policy/).

| Setting | Values (default first) | Effect |
|---|---|---|
| `mode` | `warn`, `off`, `enforce` | `warn` shows reasons on the review screen; `enforce` blocks; `off` ignores every rule. |
| `review` | `elevated`, `never`, `always` | When the install review screen appears. `elevated` means: level above `plugin`, a Route, an external or public-only tool, or an update that adds RBAC. |
| `maxLevel` | unset, or a level | Highest derived level allowed. |
| `external` / `externalMaxLevel` | `allow`, `review`, `block` / unset | Tools users paste in with Add external. |
| `publicCatalog` | `full`, `metadata-only`, `off` | What is taken from the public catalog API. |
| `rbacWidening` | `warn`, `allow`, `review`, `block` | Updates that add RBAC permissions. |
| `allowRoutes` | `true`, `false` | Bundles that create Routes. |
| `requireNetworkPolicy` | `false`, `true` | Backends must ship a NetworkPolicy. |
| `allowedRegistries` | `[]` (any) | Image registry prefixes allowed, e.g. `quay.io/cjanisze`. |
| `requireDigest` | `none`, `community`, `all` | Images must be pinned by digest. |
| `allowedDeployHosts` | `[]` (any) | Hosts a `deployURL` may point at. |
| `telemetry` | `full`, `ratings-only`, `off` | What is sent to api.octools.net. |
| `backends.<extension>.authMode` | `audit`, `enforce` | Per-extension backend mode, read at runtime by `backend-security-kit`. Existing extensions ship in `audit`: set `enforce` here to turn checking on for them. For a new (enforce) extension, `audit` is a temporary workaround. `off` is not accepted. |
| `perTool.<extension>` | overrides | Per-tool exceptions for `maxLevel`, `allowRoutes`, `requireNetworkPolicy`, `allowedRegistries`, `requireDigest`, `review`. |

How it behaves:

- **Everyone can read it, only admins can change it.** A Role in `install.yaml` lets `system:authenticated` `get` this one ConfigMap, because the storefront UI and extension backends need it. Don't put secrets in it. To let non-admins use the storefront without editing the policy, see `deploy/policy/storefront-user-role.yaml`.
- **Fails open.** An unreadable policy or an invalid value falls back to the default for that setting, and the storefront shows a banner explaining why.
- **The declaration never relaxes a rule.** Rules are checked against the derived profile. A declared level lower than the derived one adds an "exceeds declaration" warning.
- The code is `src/utils/policy.ts` (pure, unit-tested); the storefront reads the ConfigMap with `loadPolicy()`.

## Advisory vs. enforced

- **Storefront policy is advisory.** The storefront applies manifests with the logged-in user's own token, so it can show reasons, ask for review, or refuse to click Install, but it cannot stop a cluster admin from applying the same YAML by hand.
- **Hard enforcement** comes from Kubernetes itself: RBAC, and an opt-in ValidatingAdmissionPolicy pack that cluster admins apply themselves.
- **Backend modes:** new extensions ship in `enforce`. Existing extensions, when they adopt the kit, ship in `audit` and **stay there until a cluster admin switches them to `enforce`** in the policy (`backends.<extension>.authMode`). Audit lets every request through and logs what enforce would refuse, so adopting the kit never breaks a working tool.
- **Extension backends** must check every caller's permissions themselves. The console sends requests straight to the backend, not through the storefront. The shared `backend-security-kit` does this: user identity from the console proxy, a SelfSubjectAccessReview per route, and off/audit/enforce modes.

## Installing safely: what the storefront already guarantees

- **Review before install.** Every Add, Update, version change and external add first resolves the exact manifests, derives their profile and evaluates the policy. Under the defaults, plugin-only community tools still install in one click. Everything else opens the review screen, which shows:
  - the level, the declaration and the policy reasons;
  - cluster-wide permissions, each with the contributor's "why" when declared;
  - privileged access, network exposure, images and findings;
  - on Update, the permissions added or removed compared with the Roles and ClusterRoles **currently on the cluster**.

  The storefront then applies exactly the YAML that was reviewed. In `enforce` mode, a blocked install can't be confirmed.
- **Labels on tiles:** the derived level (when the manifest is known without fetching), "Not declared", and "Public-only" for tools that came only from the public catalog.
- **Ownership label.** Objects the storefront creates get `communitytools.io/extension: <tool id>`. Namespaces and the Console config are never labelled, because they can be shared.
- **Telemetry.** Only Add counts as a download; updates and version changes don't. The policy's `telemetry` setting controls what is sent to api.octools.net.
- **NetworkPolicy** is an installable kind from this release. A catalog row whose manifest contains one must set `versions[].minStorefront`, so older storefronts refuse it cleanly instead of failing the preflight.
- **No half-installs.** Before the first object is created, every document's kind is checked, and every namespace the bundle puts objects in must exist or be created by the bundle. A bundle with a kind this storefront can't apply, or that needs a namespace this cluster doesn't have (for example `openshift-storage` without ODF), fails cleanly: the review screen says why, and nothing is applied.
- **Digest-pinned images keep working.** Version detection reads the tag of `image:tag@sha256:...` references, so pinning by digest doesn't break update checks.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Contact the maintainers privately, through GitHub security advisories on the affected repository.
