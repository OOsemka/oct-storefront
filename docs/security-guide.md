# Securing Community Tools: a guide for cluster admins

This guide is task-oriented: what you see when you install a tool, how to set limits, and how to turn on the stricter checks step by step without breaking anything. The reasoning behind it (privilege levels, findings, what is advisory and what is enforced) is in [security-model.md](security-model.md).

Nothing in this guide is required. With no configuration, the storefront behaves as before, except that installs that need more than a plain console plugin show a review screen first.

## The three layers

| Layer | What it does | Who enforces it | Default |
|---|---|---|---|
| **Install review and storefront policy** | Shows what a tool will create before you install it; can warn about or refuse installs that break your rules. | The storefront UI (advisory: an admin can still apply the YAML by hand). | Review for anything beyond a plain plugin; warn, never block. |
| **Backend checks** | Extension backends check the signed-in user's permissions on every request. | Each backend (`backend-security-kit`). | Existing backends in `audit` (log only); new ones in `enforce`. |
| **Admission policy pack** | The API server rejects Community Tools objects that break your rules, however they are applied. | Kubernetes (ValidatingAdmissionPolicy). | Not installed. |

A sensible order: read the review screen on your next installs, look at the policy page, then turn on backend checks one extension at a time, then roll out the admission pack.

## 1. The install review screen

Add, Update, a version change and Add external all resolve the exact manifests first and show **Review install: _tool_** (or **Review update**) when the tool needs more than a plain plugin. Plain plugins from the community catalog still install in one click (set `review: always` to review those too).

What the screen shows:

- **Level** (derived from the manifests: plugin, namespaced, cluster-read, cluster-write, privileged) and, if the tool declares one, **Declared: _level_**. "Not declared" means the author has not described what the tool needs; the derived level is still accurate, because it comes from the manifests, not from the declaration.
- **Check before continuing**: the policy's reasons, for example "Creates Route(s) image-cache, which expose a service outside the cluster."
- **Cluster-wide permissions** and **Namespaced permissions**, each with the author's **Why** when declared. **Privileged access** (SCCs, host access), **Network**, **Images** and **Findings**.
- On an update, **Permission changes in this update**: what is added or removed compared with the Roles and ClusterRoles currently on the cluster.
- **Show the YAML that will be applied**: exactly what Install will create. The storefront applies this YAML and nothing else.

If the policy is in `enforce` mode and a rule is broken, the screen says **The cluster policy blocks this install** and Install is disabled. If something can't work on this cluster at all (a kind the storefront can't apply, a namespace that doesn't exist, for example `openshift-storage` without ODF), it says **This cannot be installed on this cluster** and nothing is applied.

**What to look for:** a privileged level on a tool whose job doesn't explain it, cluster-wide Secret access, Routes, images from registries you don't recognise, and on updates, new permissions.

## 2. The Cluster policy page

Community Tools → any hub → **View the cluster policy** (or `/community-tools/management/policy`). It is read-only and shows:

- **Storefront policy**: every setting, its effective value and its default, and where the values come from: **Defaults (no policy ConfigMap)**, the ConfigMap, or **Could not read the policy: defaults apply**. **Problems in the policy** lists values that were ignored (an invalid value falls back to its default).
- **Per-tool exceptions** and **backend auth modes**.
- **Admission policy pack**: whether it is installed, in which mode (**Warn: violations are reported, not blocked** or **Enforce: violations are rejected**), and its settings. Users who may not read these objects see **Not visible with your permissions**.
- **How to change these settings**: the commands, which are the same as below.

## 3. Setting a storefront policy

The policy is an optional ConfigMap, `oct-storefront/community-tools-policy`. Start from the commented file with every setting at its default, [`deploy/policy/community-tools-policy.yaml`](../deploy/policy/community-tools-policy.yaml), change what you need, and apply it as a cluster admin:

```sh
oc apply -f community-tools-policy.yaml
oc -n oct-storefront edit configmap community-tools-policy     # later changes
oc -n oct-storefront delete configmap community-tools-policy   # back to the defaults
```

Every authenticated user can read this ConfigMap (the storefront and the backends need it). Don't put secrets in it. Besides cluster admins, anyone bound to the `admin` or `edit` role in the `oct-storefront` namespace can change it (and `oct-admission-params`), so keep those bindings to people who may change security settings: `oc -n oct-storefront get rolebindings -o wide`.

`mode` decides what a broken rule does: `warn` (default) shows the reason on the review screen and adds "(policy would block this in enforce mode)"; `enforce` blocks the install; `off` ignores the rules. **Run in `warn` first**: install and update a few tools and read the reasons, then switch to `enforce`.

### Examples

Only the `policy.yaml` key is shown; anything you leave out keeps its default.

**Warn about everything, block nothing, review every install:**

```yaml
mode: warn
review: always
```

**Block privileged tools except the ones you approved:**

```yaml
mode: enforce
maxLevel: cluster-write
perTool:
  oct-baremetal:
    maxLevel: privileged
  oct-shift-on-shift-virt:
    maxLevel: privileged
```

**Only images from known registries, and no Routes except Bare Metal's image cache:**

```yaml
mode: enforce
allowedRegistries: [quay.io/openshift-community-tools, registry.redhat.io]
allowRoutes: false
perTool:
  oct-baremetal:
    allowRoutes: true
```

Include every registry your installed tools use (the review screen's **Images** section lists them), or updates will be blocked.

**Restrict tools that users paste in with Add external:**

```yaml
external: review          # or block
externalMaxLevel: namespaced
```

**Disconnected or locked-down cluster: no install manifests from the internet, no telemetry:**

```yaml
publicCatalog: metadata-only   # tiles and versions only; off hides public-only tools
telemetry: off
allowedDeployHosts: []         # or a list of hosts you trust for deployURLs
```

With `publicCatalog` other than `full`, only versions in the storefront's bundled catalog can be installed.

**Require a review when an update adds permissions:**

```yaml
rbacWidening: review   # allow | warn (default) | review | block
```

The full list of settings is in [security-model.md, "Cluster policy"](security-model.md#cluster-policy).

## 4. Turning on backend checks (audit → enforce)

Some extensions have a backend service that the console calls through a proxy: today the storefront's catalog-service, Bare Metal's discovery-service and Shift-on-Shift's orchestrator. With `backend-security-kit`, each request is checked against the signed-in user's own permissions (a SelfSubjectAccessReview per route). Existing extensions ship in **audit**: every request is still allowed, and requests that enforce would refuse are logged. Turn on **enforce** per extension once the logs are clean.

**Step 1: use the tool normally for a while, then read the backend's audit log.**

| Extension (policy key) | Command |
|---|---|
| `oct-storefront` | `oc -n oct-storefront logs deploy/catalog-service \| grep 'would be denied'` |
| `oct-baremetal` | `oc -n oct-baremetal logs deploy/discovery-service \| grep 'would be denied'` |
| `oct-shift-on-shift-virt` | `oc -n oct-shift-on-shift-virt logs deploy/sos-orchestrator \| grep 'would be denied'` |

Each line is JSON with `method`, `path`, `status` and `reason`, for example `"reason":"needs create baremetalhosts (metal3.io) in namespace lab-hosts"`. A line means a user did something they are not allowed to do with `oc`. Either that is correct (they shouldn't), or the user needs that permission (grant it with RBAC), or the extension asks for the wrong permission (report it to the extension's maintainers).

**Step 2: switch that extension to enforce** in the policy ConfigMap:

```yaml
backends:
  oct-baremetal:
    authMode: enforce
```

The backend picks the change up within about a minute; no restart is needed. A denied request then gets an HTTP error with the same `reason` as the audit line, the tool shows that error, and the log says `request denied`.

**Going back:** set `authMode: audit` (or remove the entry) for that extension. `off` is not accepted: the policy can only choose between logging and enforcing.

New extensions ship in enforce. Setting one of them to `audit` is a temporary workaround while a permission problem is fixed.

## 5. Rolling out the admission policy pack (warn → watch → enforce)

The pack in [`deploy/policy/vap/`](../deploy/policy/vap/README.md) makes the API server itself check objects created by Community Tools (labelled `communitytools.io/extension`, or created by a service account in an `oct-*` namespace). It refuses bindings to `cluster-admin`/`admin`/`edit`, images from registries you didn't allow, Routes, SCC changes and SCC role bindings by extensions you didn't approve, and extensions changing the security configuration itself. It applies to YAML applied by hand too, which the storefront policy can't stop.

**Step 1: settings and warn mode.** From a checkout of this repository:

```sh
oc create -f deploy/policy/vap/params.yaml   # settings ConfigMap oct-storefront/oct-admission-params, once
oc apply -k deploy/policy/vap                # Warn + Audit: nothing is blocked
```

Edit the settings for your cluster with `oc -n oct-storefront edit configmap oct-admission-params`:

```yaml
data:
  allowedRegistries: "quay.io/openshift-community-tools,registry.redhat.io"   # empty: any
  requireDigest: "false"
  approvedRoutes: "oct-baremetal"              # extensions allowed to create Routes
  approvedSCCs: "oct-network-dhcp"             # extensions allowed to manage SCCs
  approvedSCCBindings: "oct-shift-on-shift-virt:anyuid"   # extension:SCC role bindings
```

With today's catalog, expect: Shift-on-Shift's `anyuid` SCC role bindings for every nested cluster (approve `oct-shift-on-shift-virt:anyuid` in `approvedSCCBindings`, or **every Shift-on-Shift install fails in enforce**), Bare Metal's `image-cache` Route (approve `oct-baremetal`), Shift-on-Shift's host Routes when external access is on (approve `oct-shift-on-shift-virt` in `approvedRoutes`), and DHCP's SCC (approve `oct-network-dhcp` in `approvedSCCs`).

**Step 2: watch.** Install, update and use your tools for a while. Violations show up as warnings in `oc` output and in the storefront's install errors, and as audit annotations in the API audit log. The Cluster policy page shows the pack in **Warn**.

**Step 3: enforce** when the warnings are gone or understood:

```sh
oc apply -k deploy/policy/vap/enforce        # Deny + Audit: violations are rejected
oc apply -k deploy/policy/vap                # back to warn
oc delete -k deploy/policy/vap               # remove the policies (the settings ConfigMap stays)
```

Switching modes never touches your settings. If the settings ConfigMap is deleted, the image, Route, SCC and SCC-binding rules are skipped rather than blocking the cluster; the cluster-admin/admin/edit binding rule stays active. Known gaps are listed in the pack's README.

When an install through the storefront is rejected half-way, the storefront removes the objects that attempt had created and says so in the error. Objects that already existed are never touched.

## 6. NetworkPolicies for the storefront

New installs of the storefront (from `deploy/install.yaml`) include NetworkPolicies that let only the console reach the storefront plugin and catalog-service. A storefront that **updated itself** from a version before 1.6 can't create them, so on such a cluster apply them once:

```sh
oc apply -f deploy/policy/storefront-networkpolicy.yaml
```

Check with `oc -n oct-storefront get networkpolicy`. Extensions ship their own NetworkPolicies; `requireNetworkPolicy: true` in the policy flags (or, in enforce, blocks) backends without one.

## 7. Letting non-admins use the storefront

[`deploy/policy/storefront-user-role.yaml`](../deploy/policy/storefront-user-role.yaml) lets a group browse the storefront and refresh its catalog without being able to change the policy:

```sh
oc apply -f deploy/policy/storefront-user-role.yaml
oc -n oct-storefront create rolebinding oct-storefront-users --role=oct-storefront-user --group=<your-group>
```

Installing a tool still needs the permissions of the tool's own manifests, which for most tools means a cluster admin. Because these users can write the catalog cache, a catalog entry that differs from the storefront's bundled catalog always opens the review screen ("comes from the synced catalog").

## Troubleshooting

| Message | Where | Meaning and fix |
|---|---|---|
| Needs _level_ access; this cluster allows at most _maxLevel_. | Review screen | The tool's derived level is above `maxLevel`. Approve it with `perTool.<tool>.maxLevel`, or don't install it. |
| Creates Route(s) _names_, which expose a service outside the cluster. | Review screen | `allowRoutes: false`. Allow it per tool with `perTool.<tool>.allowRoutes: true`. |
| Images from registries not on the allowed list: … | Review screen | Add the registry to `allowedRegistries` (globally or per tool). |
| Images not pinned by digest: … | Review screen | `requireDigest` is on and the tool uses tags. Ask the maintainer for digest-pinned releases, or relax it per tool. |
| Runs a backend service without a NetworkPolicy. | Review screen | `requireNetworkPolicy: true`. Ask the maintainer to ship one, or set `perTool.<tool>.requireNetworkPolicy: false`. |
| This update adds permissions: … | Review screen | The update widens RBAC; read what is added before confirming. Controlled by `rbacWidening`. |
| The manifests need _X_ access, but the tool declares _Y_. | Review screen | The declaration understates the tool. The derived level is the one that counts; report it to the maintainer. |
| This version comes from the synced catalog, not from this storefront's bundled catalog … | Review screen | A newer release from the public catalog, or an edited cache. Check the image and manifests before installing. |
| Installs from the public catalog are turned off on this cluster … | Review screen | `publicCatalog` isn't `full`; only bundled versions can be installed. |
| Install manifest comes from _host_, which is not an allowed host. | Review screen | Add the host to `allowedDeployHosts`, or don't install it. |
| Could not read the policy: defaults apply | Policy page, banner | The ConfigMap couldn't be read or isn't valid YAML. Fix it with `oc -n oct-storefront get configmap community-tools-policy -o yaml`. |
| Problems in the policy | Policy page | Listed values were ignored and their defaults apply. |
| `needs <verb> <resource> (<group>) in namespace <ns>` or `… cluster-wide` (HTTP 403) | A tool's page, backend log `request denied` | The backend is in enforce and the user lacks that permission. Grant it with RBAC if the user should have it. To unblock while investigating, set the extension's `authMode: audit`. |
| `no user token (the ConsolePlugin proxy needs authorization: UserToken)` (HTTP 401) | A tool's page or backend log | The tool's ConsolePlugin proxy doesn't forward the user's identity. Reinstall or update the tool; if it persists, report it to the maintainer. |
| `could not check permissions` (HTTP 503) | A tool's page | The backend couldn't reach the API server for the access review. Check the backend's logs and the API server. |
| `cluster policy: problems in backends` / `could not read the cluster policy; keeping the last auth-mode overrides` | Backend log | A `backends` entry is invalid, or the policy couldn't be read. The backend keeps its last good modes. |
| Community Tools extension _X_ is not approved to create Routes (…); add it to approvedRoutes in oct-admission-params | `oc` or install error | Admission pack. Add the extension to `approvedRoutes` if you allow it. |
| Community Tools extension _X_ uses images outside allowedRegistries: … | `oc` or install error | Admission pack. Add the registry to `allowedRegistries` in `oct-admission-params`. |
| Community Tools extension _X_ must pin images by digest: … | `oc` or install error | Admission pack with `requireDigest: "true"`. |
| Community Tools extension _X_ may not bind the _role_ ClusterRole (…) | `oc` or install error | Admission pack: bindings to cluster-admin/admin/edit are never allowed for extensions. Report it to the maintainer. |
| Community Tools extension _X_ is not approved to bind the system:openshift:scc:_scc_ ClusterRole (…) | `oc`, install error or extension log | Admission pack: add `X:scc` to `approvedSCCBindings` if you allow it (Shift-on-Shift needs `oct-shift-on-shift-virt:anyuid`). |
| Community Tools extension _X_ is not approved to … SecurityContextConstraints (…) | `oc` or install error | Admission pack. Add the extension to `approvedSCCs` if you allow it. |
| Community Tools extension _X_ may not … (the security configuration that governs Community Tools) | `oc` or extension log | An extension tried to change the policy, the admission settings or the pack. Always refused; investigate the extension. |
| Creating _Kind/name_ failed: … The _n_ object(s) this install had created were removed again. | Install error | Something (often the admission pack) rejected an object half-way; the storefront rolled the install back. Fix the cause and retry. |

## Reporting a vulnerability

Don't open a public issue. Use GitHub security advisories on the affected repository (see [SECURITY.md](../SECURITY.md)); a tool's review screen shows its **Security contact** when the tool declares one.
