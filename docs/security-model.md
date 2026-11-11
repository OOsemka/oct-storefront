# OCT security model

This page explains how Community Tools thinks about security, what is enforced today, and what is advisory. It is the reference for contributors, cluster admins and reviewers. The full proposal is in [rfc-security-framework.md](rfc-security-framework.md). For step-by-step admin tasks (policy examples, turning on enforcement, troubleshooting), see [security-guide.md](security-guide.md).

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
| `cluster-write` | Cluster-wide write verbs, or objects and RBAC in a namespace the bundle doesn't create. |
| `privileged` | Any of: SCC use or definition, hostNetwork/hostPID/hostIPC/hostPath, privileged containers, added capabilities, RBAC wildcards, escalate/bind/impersonate, cluster-wide Secret read, cluster-wide pods/exec (or attach, port-forward), cluster-wide workload creation or change (including ephemeral containers), cluster-wide RBAC writes, Node writes or the node proxy, ServiceAccount token creation, SCC writes, admission webhook or policy writes, PersistentVolume creation, user/group/identity writes, certificate approval, `aggregationRule` or adding rules to the built-in admin/edit/view roles, a cluster-wide binding to cluster-admin/admin/edit, any object in `oct-storefront` or a platform namespace (`openshift`, `openshift-*`, `kube-*`, `default`), or a Namespace that skips pod security (`openshift.io/run-level`, pod-security `privileged`). |

**A ClusterRole defined but not bound in the bundle is treated as cluster-wide**, because it may be bound at runtime. **RBAC inside a platform namespace is judged like cluster-wide RBAC**, because its ServiceAccounts and configuration are cluster-critical. **Objects in `oct-storefront` are always privileged**: that is where the cluster policy, the admission settings and the storefront's caches live, so a bundle that writes there could switch the checks off.

## Findings

Besides the level, the profile lists findings, each with a stable id:

| Area | Finding ids |
|---|---|
| RBAC | `rbac-wildcard`, `rbac-escalate`, `rbac-bind`, `rbac-impersonate`, `rbac-cluster-secrets-read`, `rbac-cluster-pods-exec`, `rbac-cluster-workload-create`, `rbac-cluster-rbac-write`, `rbac-cluster-nodes-write`, `rbac-cluster-namespaces-delete`, `rbac-cluster-sa-token`, `rbac-cluster-admission-write`, `rbac-cluster-pv-create`, `rbac-cluster-nodes-proxy`, `rbac-cluster-identity-write`, `rbac-cluster-csr-approve`, `rbac-scc-write`, `rbac-aggregation-rule`, `rbac-aggregates-into-builtin`, `rbac-binds-cluster-admin`, `rbac-binds-builtin-*`, `rbac-binds-external-role`, `rbac-unbound-clusterrole` |
| Placement | `object-in-storefront-namespace`, `object-in-platform-namespace`, `object-outside-own-namespace`, `namespace-privileged` |
| SCC and host access | `scc-use`, `scc-defined`, `host-hostNetwork`, `host-hostPID`, `host-hostIPC`, `host-path`, `container-privileged`, `capability-*` |
| Network | `route-exposed`, `route-exposed-plain-http`, `service-exposed`, `backend-no-networkpolicy` |
| Backend identity | `proxy-no-user-token` (the ConsolePlugin proxy doesn't forward the user's identity with `authorization: UserToken`) |
| Secrets | `secret-with-data` (credentials shipped inside the bundle) |
| Images | `image-mutable-tag` (no tag or `:latest`) |
| Hardening (info only) | `workload-hardening` (missing allowPrivilegeEscalation: false / readOnlyRootFilesystem: true / non-root) |

## CI: report and ratchet

`yarn security-check` derives the profile of every bundle the storefront can install (`catalog/deploy/<tool>.yaml`, inline `deployYAML` on a catalog row or tool, and `deployURL`s that point into this repository, which are read from the local file; a `deployURL` anywhere else fails `--strict` because CI can't check what it serves) and compares the findings with [`catalog/security-baseline.json`](../catalog/security-baseline.json):

- Findings already in the baseline are **tolerated**. They are the known issues of existing tools.
- CI runs `yarn security-check --strict`, which **fails** on:
  - a **new** finding. Fix it, or accept it deliberately with `yarn security-check --update-baseline` and say why in the PR;
  - a **stale** baseline entry: a finding that was fixed, or whose bundle was removed, but is still listed. Remove it with `--update-baseline` and check that the diff only removes lines. This keeps the baseline shrinking: once something is fixed, it can't quietly come back;
  - a **declaration mismatch**: `spec.security.level` lower than the level the bundle derives, or a Route the declaration doesn't list. A tool without any declaration is only noted (declarations are optional);
  - a **hard rule** (below), which is never tolerated, not even when added to the baseline;
  - **declaration drift**: a declared tool's bundle changed since its declaration was last reviewed. [`catalog/declaration-review.json`](../catalog/declaration-review.json) keeps a fingerprint of each bundle that ignores image tags, digests and version labels, so routine releases don't trip it; anything else does (RBAC, CRD fields, new objects, ports). Static checks can't see everything a bundle does at runtime (for example a CRD field that makes the tool publish Routes), so a person reads the bundle diff, updates `spec.security` if needed, and records it with `yarn security-check --mark-reviewed <tool>`.
- Without `--strict` (local runs), the same report is printed but only the hard rules below fail.

The goal is an empty baseline. Besides the ratchet, these **hard rules** always fail CI:

- a bundle that is not valid YAML or contains no Kubernetes objects (the derivation would otherwise see an empty, harmless-looking profile);
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
| `publicCatalog` | `full`, `metadata-only`, `off` | What is taken from the public catalog API. With anything but `full`, versions that aren't in the storefront's bundled catalog can't be installed (blocked in enforce, flagged in warn); `off` also hides tools that came only from the public catalog, even if an earlier sync cached them. |
| `rbacWidening` | `warn`, `allow`, `review`, `block` | Updates that add RBAC permissions. |
| `allowRoutes` | `true`, `false` | Bundles that create Routes. |
| `requireNetworkPolicy` | `false`, `true` | Backends must ship a NetworkPolicy. |
| `allowedRegistries` | `[]` (any) | Image registry prefixes allowed, e.g. `quay.io/openshift-community-tools`. |
| `requireDigest` | `none`, `community`, `all` | Images must be pinned by digest. |
| `allowedDeployHosts` | `[]` (any) | Hosts a `deployURL` may point at. |
| `telemetry` | `full`, `ratings-only`, `off` | What is sent to api.octools.net. |
| `backends.<extension>.authMode` | `audit`, `enforce` | Per-extension backend mode, read at runtime by `backend-security-kit`. Existing extensions ship in `audit`: set `enforce` here to turn checking on for them. For a new (enforce) extension, `audit` is a temporary workaround. `off` is not accepted. |
| `perTool.<extension>` | overrides | Per-tool exceptions for `maxLevel`, `allowRoutes`, `requireNetworkPolicy`, `allowedRegistries`, `requireDigest`, `review`. |

How it behaves:

- **Everyone can read it; cluster admins, and anyone bound to the `admin` or `edit` role in `oct-storefront`, can change it.** Keep those namespace bindings to people who may change security settings (the policy can, for example, set a backend back to audit). A Role in `install.yaml` lets `system:authenticated` `get` this one ConfigMap, because the storefront UI and extension backends need it. Don't put secrets in it. To let non-admins use the storefront without editing the policy, see `deploy/policy/storefront-user-role.yaml`.
- **Fails open.** An unreadable policy or an invalid value falls back to the default for that setting, and the storefront shows a banner explaining why.
- **The declaration never relaxes a rule.** Rules are checked against the derived profile. A declared level lower than the derived one adds an "exceeds declaration" warning.
- The code is `src/utils/policy.ts` (pure, unit-tested); the storefront reads the ConfigMap with `loadPolicy()`.
- **Cluster policy page** (Community Tools → any hub → "Cluster policy", or `/community-tools/management/policy`): a read-only view of the effective settings and their defaults, where they come from (defaults, the ConfigMap, or a read error with defaults in effect), parse warnings, per-tool exceptions, backend auth modes, and whether the admission policy pack is installed and in which mode. Users who may not read the admission objects see "not visible" instead of an error.

## Advisory vs. enforced

- **Storefront policy is advisory.** The storefront applies manifests with the logged-in user's own token, so it can show reasons, ask for review, or refuse to click Install, but it cannot stop a cluster admin from applying the same YAML by hand.
- **Hard enforcement** comes from Kubernetes itself: RBAC, and an opt-in ValidatingAdmissionPolicy pack that cluster admins apply themselves ([`deploy/policy/vap/`](../deploy/policy/vap/README.md)). It ships in Warn + Audit; `oc apply -k deploy/policy/vap/enforce` makes it reject violations. It checks objects with the `communitytools.io/extension` label and requests from service accounts in `oct-*` namespaces:
  - no RoleBinding or ClusterRoleBinding to `cluster-admin`, `admin` or `edit`;
  - images only from `allowedRegistries`, pinned by digest if `requireDigest` is on;
  - Routes only for extensions listed in `approvedRoutes`;
  - SCC changes only for extensions listed in `approvedSCCs`;
  - SCC role bindings (`system:openshift:scc:*`) only for extensions listed in `approvedSCCBindings` (Shift-on-Shift needs `oct-shift-on-shift-virt:anyuid`).

  Its settings live in their own ConfigMap (`oct-admission-params`), separate from the storefront policy, because admission policies can't parse the YAML inside `community-tools-policy`. If that ConfigMap is missing, the settings-based rules are skipped rather than blocking the cluster.
- **Backend modes:** new extensions ship in `enforce`. Existing extensions, when they adopt the kit, ship in `audit` and **stay there until a cluster admin switches them to `enforce`** in the policy (`backends.<extension>.authMode`). Audit lets every request through and logs what enforce would refuse, so adopting the kit never breaks a working tool.
- **Extension backends** must check every caller's permissions themselves. The console sends requests straight to the backend, not through the storefront. The shared `backend-security-kit` does this: user identity from the console proxy, a SelfSubjectAccessReview per route, and off/audit/enforce modes.

## Installing safely: what the storefront already guarantees

- **Review before install.** Every Add, Update, version change and external add first resolves the exact manifests, derives their profile and evaluates the policy. Under the defaults, plugin-only community tools still install in one click. Everything else opens the review screen, which shows:
  - the level, the declaration and the policy reasons;
  - cluster-wide permissions, each with the contributor's "why" when declared;
  - privileged access, network exposure, images and findings;
  - on Update, the permissions added or removed compared with the Roles and ClusterRoles **currently on the cluster**.

  The storefront then applies exactly the YAML that was reviewed. In `enforce` mode, a blocked install can't be confirmed.
- **Synced rows are reviewed.** The catalog is read from a cache ConfigMap that the optional `storefront-user` role lets non-admins write. A version whose image or manifest differs from the storefront's own bundled catalog (a newer release from the public catalog, or an edited cache) always opens the review screen with the reason "comes from the synced catalog", so nobody can change what a one-click install applies.
- **Telemetry waits for the policy.** Nothing is sent before the policy has loaded, or when it couldn't be read. catalog-service, which forwards download counts and ratings to api.octools.net, enforces the policy's `telemetry` setting itself too (an unreadable policy sends nothing), so a pod in the cluster can't send what the browser wouldn't.
- **catalog-service checks every caller** (backend-security-kit, audit by default; `backends.oct-storefront.authMode: enforce` turns it on): reading the catalog or fetching a manifest needs what every storefront user has, sending stats the right to update the storefront's stats. Its HTTP port serves only `/healthz`.
- **NetworkPolicies for the storefront** (only the console reaches the plugin and catalog-service) come with new installs; storefronts before 1.6 can't apply them while updating themselves, so on an updated cluster apply `deploy/policy/storefront-networkpolicy.yaml` once.
- **Labels on tiles:** the derived level (when the manifest is known without fetching), "Not declared", and "Public-only" for tools that came only from the public catalog.
- **Tools without their own manifests** (an image only, for example many external tools) get manifests generated by the storefront: a non-root plugin Deployment with no privilege escalation, all capabilities dropped, no ServiceAccount token, and a console-only NetworkPolicy. The root filesystem stays writable, because the storefront can't know where an unknown image writes; bundles that know their image set `readOnlyRootFilesystem` themselves.
- **Ownership label.** Objects the storefront creates get `communitytools.io/extension: <tool id>`. Namespaces and the Console config are never labelled, because they can be shared.
- **Telemetry.** Only Add counts as a download; updates and version changes don't. The policy's `telemetry` setting controls what is sent to api.octools.net.
- **NetworkPolicy** is an installable kind from this release. A catalog row whose manifest contains one must set `versions[].minStorefront`, so older storefronts refuse it cleanly instead of failing the preflight.
- **No half-installs.** Before the first object is created, every document's kind is checked, and every namespace the bundle puts objects in must exist or be created by the bundle. A bundle with a kind this storefront can't apply, or that needs a namespace this cluster doesn't have (for example `openshift-storage` without ODF), fails cleanly: the review screen says why, and nothing is applied. If a create still fails part-way (for example the API server's admission policy pack denies an object), the storefront deletes the objects that attempt had created, newest first, and says so in the error; objects that already existed are never touched. The plugin is only enabled and the install only recorded after every object was applied.
- **Digest-pinned images keep working.** Version detection reads the tag of `image:tag@sha256:...` references, so pinning by digest doesn't break update checks.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Contact the maintainers privately, through GitHub security advisories on the affected repository.
