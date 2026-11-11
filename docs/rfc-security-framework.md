# RFC: OCT security framework

**Status:** draft for discussion · **Authors:** Darin Sorrentino (`dsorrentino`) with Claude Code · **For:** Chris Janiszewski (OCT maintainer)

## Why

OCT makes it easy to add powerful tools to the OpenShift console. As more contributors add extensions, the framework needs a consistent, configurable way to keep them safe. Today each extension decides alone how it authenticates callers, what RBAC it gets, and how it is exposed, and the storefront installs whatever a bundle contains with the clicking admin's token and no preview.

This RFC proposes a framework-level answer. It is built **into the base toolkit first, with defaults that don't break anything**, and then adopted by each extension in turn.

**Goals:**
- **Extensible.** A contributor declares what their extension needs, using a small, documented schema.
- **Configurable.** Cluster admins set policy once for all extensions, from permissive to strict.
- **Adoption-friendly.** Plugin-only tools stay one-click, and the defaults keep today's behaviour.
- **Non-breaking.** Old catalog rows, old storefronts and existing installs keep working.

**Out of scope here:**
- Input validation fixes in Shift-on-Shift, Windows Builder and Storage Bench (Chris is already on these; finding #5).
- Rotating the stats API admin token and deploying the worker (Chris).

## The model: Declare → Derive → Decide

1. **Declare.** An extension may add a `spec.security` block to its catalog entry: what it needs and *why*. It's optional, so existing rows simply show "Not declared".
2. **Derive.** The storefront (at install) and CI (at PR time) compute the extension's actual profile from the manifests that will really be applied: kinds, RBAC, SCC/host access, images, Routes. This is the source of truth; the declaration is never trusted on its own.
3. **Decide.** A cluster-admin policy is evaluated against the derived profile: allow, warn, review or block, with reasons shown in the UI.

Every install gets a derived **privilege level**:

| Level | Meaning |
|---|---|
| `plugin` | UI only |
| `namespaced` | ServiceAccount/Role/PVC in its own namespace |
| `cluster-read` | Read-only cluster RBAC or CRDs |
| `cluster-write` | Cluster write verbs |
| `privileged` | SCC use, host access, wildcard or escalate rules, cluster-wide secret read, or a binding to cluster-admin |

## 1. Contributor declaration (`spec.security`)

```yaml
spec:
  security:
    schema: 1
    level: cluster-write
    summary: "Creates NestedCluster VMs; needs cluster-wide KubeVirt access."
    backend: { services: [orchestrator], auth: ssar, authModeDefault: audit, publicPaths: [] }
    network:
      ingress: console-only
      routes: []                      # each Route listed with a reason
      networkPolicy: true
      egress: [{ host: quay.io, why: "pull images" }]
    rbac:
      rules:
        - { apiGroups: [kubevirt.io], resources: [virtualmachines], verbs: [create, delete], why: "..." }
    privileged: { scc: [], hostAccess: [], runtimeCreates: [] }
    secrets: { access: namespaced, why: "..." }
    supplyChain: { digestPinned: false, signed: none }
```

- Optional per-version override: `versions[].security`.
- New optional `versions[].minStorefront`.
- Older storefronts ignore these fields, because their parsers use allow-lists.
- The storefront keeps unknown keys, so newer schemas survive a round-trip.

## 2. Cluster-admin policy

A ConfigMap **`community-tools-policy`** in `oct-storefront`. If it's absent, the built-in defaults apply.

```yaml
mode: warn                # off | warn | enforce   (default warn: show reasons, block nothing)
review: elevated          # never | elevated | always (default elevated)
maxLevel: privileged
external: allow           # allow | review | block
publicCatalog: full       # full | metadata-only | off
rbacWidening: allow       # allow | warn | review | block   (RBAC growth on Update)
allowedRegistries: ["*"]
requireDigest: false
telemetry: full           # full | ratings-only | off
backends:                 # runtime override per extension backend
  oct-baremetal: { authMode: enforce }   # existing extensions ship in audit; the admin turns on enforce
```

How the policy is read and protected:
- **Readable by everyone** (storefront UI and extension backends): `get` on this one ConfigMap.
- **Editable by cluster admins**; regular storefront users are limited to the cache ConfigMaps.
- **Advisory by default.** The storefront applies manifests with the user's own token, so it can't truly enforce anything.
- **Hard enforcement is opt-in:** a ValidatingAdmissionPolicy pack ships in Audit/Warn mode, and admins apply it themselves:
  - no binding to cluster-admin;
  - registry and digest rules;
  - Route approval;
  - SCC creation.

## 3. Install review

- With the default `review: elevated`, **plugin-only tools stay one-click**. Elevated tools (`cluster-write`, `privileged`), anything with a Route, and pasted external tools show a **review screen** first. It lists the privilege level, summary, cluster RBAC with each declared reason, SCC/host access, images (registry, digest) and Routes. On Update, it also shows **what RBAC changes**.
- What you review is exactly what gets applied, including manifests fetched from a `deployURL`.
- The installer **checks every kind before creating anything**, so an install never ends up half-applied.

## 4. `backend-security-kit` (shared Go library for extension backends)

The console sends extension API calls straight to each extension's backend; the storefront isn't involved. So the permission check must run inside each backend. This stdlib-only library (living in `oct-storefront/backend-security-kit/`) gives every backend the same check.

| Package | What it does |
|---|---|
| `auth` | Identifies the caller (the console forwards the user token via `authorization: UserToken`) and checks the required permission per route with a SelfSubjectAccessReview. Contributors declare a route table, e.g. `POST /api/v1/clusters` needs `create nestedclusters`. Modes are **off / audit / enforce**: audit logs would-be denials, enforce returns 403, and unmapped routes are denied in enforce. The effective mode can be **overridden per extension by the cluster policy at runtime**. |
| `server` | HTTPS only, a plain port for health checks only, timeouts and size limits, no CORS. It refuses to start unencrypted. |
| `kubeclient` | Verifies the cluster CA instead of skipping TLS checks, and supports calls made as the user. |
| `validate` | Kubernetes name and namespace validation, namespace allow-lists, safe paths, and running commands without a shell. |
| manifests | Proxy `authorization: UserToken`, plus a NetworkPolicy that allows only the console to reach the backend. |

Long-running work (provisioning, image builds) keeps using the backend's ServiceAccount. The check happens when the request arrives, and the requester is recorded on the CRs created.

## 5. Contributor experience

- **Templates:** a hardened plugin (no `chmod 777`, no CORS `*`, read-only root filesystem), plus a new **backend template** that uses the kit in enforce mode. Each template includes an example `security:` block.
- **CI:**
  - `check-repo.sh` gains security rules (warn first).
  - `validate-catalog.sh` checks declared ≥ derived.
  - A **ratchet baseline** means existing findings don't fail CI; only new ones do.
- **Docs:** a Security section in `extension-standard.md`, a new `security-model.md`, PR checklist items, `oct-security.mdc`, an AGENTS.md section, and website pages.

## 6. Stats API (`octools-stats-worker`)

- Constant-time admin token compare, plus an admin rate limit.
- Writes accepted only for known tool IDs, with `clusterHash` validated.
- A global rate limit (Workers rate-limit binding).
- An optional `security` column so catalog rows can carry declarations.
- Telemetry stays on by default. Admins can turn it down to ratings-only or off, and **Updates no longer count as downloads**.

## Rollout

1. **Groundwork, no behaviour change:** preflight, digest-safe version parsing, tests, profile derivation, report-only CI.
2. **Framework knobs:** declarations, policy (warn / elevated review), review screen, labels, telemetry knob, the kit (v0.1), templates, docs. Declarations are added to all catalog rows.
3. **Opt-in enforcement:** enforce mode, the admission-policy pack, the policy page, `UserToken` on every bundled proxy.
4. **Migrate extensions one at a time.** Each adopts the kit in **audit**, and stays in audit until a cluster admin enables enforce for it in the policy (new extensions ship in enforce). Risk order: Bare Metal → Storage Bench → Shift-on-Shift → Windows Builder → Network DHCP → catalog-service → browser-only tools and templates.
5. **Strict defaults** in a major release; `mode: off` restores the old behaviour.

All of this is being developed and tested in forks (`dsorrentino/*`) on a disposable nested OpenShift 4.22 cluster. It will be offered as one tested set of PRs, with a test report. Version bumps, image tags, catalog rows and API seeding stay with the maintainer at merge.

## Questions for Chris

1. Is the `spec.security` schema and the five privilege levels the right vocabulary for OCT?
2. Is a ConfigMap (not a CRD) acceptable for cluster policy?
3. Is `oct-storefront/backend-security-kit/` the right home, or would you prefer a separate repo or org later?
4. Are the defaults right: warn mode, review for elevated tools, telemetry on with an opt-out, and Updates not counted as downloads?
5. Any extension-specific constraints we should know before migrating it (especially Shift-on-Shift, given Maciej's ongoing work)?
