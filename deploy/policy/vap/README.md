# Admission policy pack for Community Tools

Optional ValidatingAdmissionPolicies that the **API server** enforces, so they also apply to YAML applied by hand, not only to installs through the storefront. A cluster admin applies them; the storefront never does. Background: [docs/security-model.md](../../../docs/security-model.md).

## Apply

```sh
oc create -f deploy/policy/vap/params.yaml   # settings, once (create never overwrites)
oc apply -k deploy/policy/vap                # Warn + Audit: nothing is blocked
```

Warnings appear in `oc` output and API warnings; audit annotations go to the API audit log. When the warnings look right:

```sh
oc apply -k deploy/policy/vap/enforce        # Deny + Audit: violations are rejected
oc apply -k deploy/policy/vap                # back to warn
oc delete -k deploy/policy/vap               # remove the policies (the settings ConfigMap stays)
```

Switching between warn and enforce never touches the settings, because `params.yaml` is not part of either kustomization.

## What counts as a Community Tools request

A request is checked if **either**:

- the object carries the `communitytools.io/extension` label (everything the storefront installs, on create, update or when the label is removed), or
- it comes from a service account in a namespace whose name starts with `oct-` (objects an extension creates at runtime, such as Shift-on-Shift's Routes and RoleBindings).

Everything else on the cluster is ignored. If unrelated software on your cluster also uses `oct-*` namespaces, its service accounts are checked too.

## The policies

| Policy | Rule | Settings |
|---|---|---|
| `oct-no-broad-role-bindings` | No RoleBinding or ClusterRoleBinding to the `cluster-admin`, `admin` or `edit` ClusterRole. | none, always active |
| `oct-scc-role-bindings` | RoleBindings and ClusterRoleBindings to an SCC role (`system:openshift:scc:<scc>`, which grants use of that SCC) only for extensions listed in `approvedSCCBindings`. | `approvedSCCBindings` |
| `oct-image-rules` | Pods (including ephemeral debug containers), Deployments, DaemonSets, StatefulSets, ReplicaSets, Jobs and CronJobs: images (including init containers) must come from `allowedRegistries`, and be pinned by digest when `requireDigest` is `"true"`. | `allowedRegistries`, `requireDigest` |
| `oct-route-approval` | Only extensions listed in `approvedRoutes` may create or change Routes, or Ingresses (the OpenShift router turns them into Routes). | `approvedRoutes` |
| `oct-scc-changes` | Only extensions listed in `approvedSCCs` may create, change or delete SecurityContextConstraints. | `approvedSCCs` |
| `oct-protect-security-config` | Extensions (service accounts in `oct-*`) may not change or delete `community-tools-policy`, `oct-admission-params`, or these policies and bindings. Without it, an extension with broad ConfigMap permissions could delete the settings and so switch off the three rules above. | none, always active |

The extension id in messages and approval lists is, for a request from an `oct-*` service account, that service account's namespace (for example `oct-baremetal`), whatever labels the object carries, so a label can't borrow another extension's approval. For other requests (an admin installing through the storefront) it is the `communitytools.io/extension` label.

**Updates that don't change what a rule is about are not re-checked**: scaling or relabelling a Deployment, or removing a finalizer, keeps working in enforce mode even for objects created while the pack was in warn. The image rule re-checks when an image changes, the Route rule when the spec changes, the binding rule when the subjects change.

## Settings (`params.yaml`, ConfigMap `oct-storefront/oct-admission-params`)

| Key | Example | Meaning |
|---|---|---|
| `allowedRegistries` | `quay.io/openshift-community-tools,registry.redhat.io` | Comma-separated prefixes. An entry matches at a path boundary: `registry.redhat.io` allows `registry.redhat.io/ubi9/...`, not `registry.redhat.io.example.com/...`. Empty: any registry. |
| `requireDigest` | `"true"` | Every image must contain `@sha256:`. |
| `approvedRoutes` | `oct-baremetal` | Extensions allowed to manage Routes. `*` approves all. Empty: none. |
| `approvedSCCs` | `oct-network-dhcp` | Extensions allowed to manage SCCs. `*` approves all. Empty: none. |
| `approvedSCCBindings` | `oct-shift-on-shift-virt:anyuid` | Extensions allowed to bind SCC roles: `<extension>:<scc>` approves one SCC, `<extension>` any SCC (including `privileged`, so prefer the scoped form), `*` everyone. Empty: none. |

Edit with `oc -n oct-storefront edit configmap oct-admission-params`; changes apply within seconds.

**If the ConfigMap is missing,** the image, Route, SCC and SCC-binding rules are skipped (they fail open). This is deliberate: Kubernetes evaluates a binding's missing parameters before the policy's match conditions, so failing closed would block every Pod and Deployment on the cluster, not just Community Tools. The cluster-admin/admin/edit binding rule needs no settings and stays active.

## Expected warnings with today's catalog

- **Shift-on-Shift** binds the `anyuid` SCC role for each nested cluster's helper pods (three ClusterRoleBindings): add `oct-shift-on-shift-virt:anyuid` to `approvedSCCBindings`, or **every Shift-on-Shift install fails in enforce**.
- **Bare Metal** creates the `image-cache` Route: add `oct-baremetal` to `approvedRoutes` if you allow it.
- **Shift-on-Shift** creates Routes at runtime when `externalAccess.hostRoutes` (or `publishAppRoutes`) is on: add `oct-shift-on-shift-virt` to `approvedRoutes` if you allow it.
- **DHCP** creates the `oct-dhcp-netraw` SecurityContextConstraints from its page when you deploy a DHCP server, and deletes it with the last server: add `oct-network-dhcp` to `approvedSCCs` if you allow it.
- With `allowedRegistries` set, add every registry your installed tools use (the review screen in the storefront lists their images).

No catalog tool binds `cluster-admin`, `admin` or `edit`, or ships an SCC in its bundle.

## What the pack does not cover

It is a guard rail for the common paths, not a sandbox. Known gaps, so you can decide what else you need:

- **Identity laundering.** An extension that may exec into pods or create workloads in other namespaces (several do, see their review screens) can act as a service account outside `oct-*`, whose requests the pack doesn't check. Keep such permissions out of extensions, or bind them only where needed.
- **Other image carriers.** VirtualMachine container disks, DeploymentConfigs and BuildConfigs aren't checked.
- **SCC use through RBAC.** Bindings to `system:openshift:scc:*` roles need approval, but a custom or aggregated role with `use` on an SCC is not. The storefront's review screen flags those (`scc-use`, `rbac-aggregation-rule`).
- **Settings fail open.** If `oct-admission-params` is deleted by an admin, the image, Route, SCC and SCC-binding rules are skipped (see above). Extensions themselves can't delete it (`oct-protect-security-config`).

