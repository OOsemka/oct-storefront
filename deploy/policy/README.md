# Cluster policy for Community Tools

Optional settings a cluster admin can use to decide what the storefront may install. Details and the reasoning are in [docs/security-model.md](../../docs/security-model.md).

| File | What it is |
|---|---|
| [`community-tools-policy.yaml`](community-tools-policy.yaml) | The policy ConfigMap with every setting at its default, commented. Copy, edit, `oc apply -f`. |
| [`storefront-user-role.yaml`](storefront-user-role.yaml) | Optional Role for non-admin storefront users: they can use the catalog cache and add external tools, but can't change the policy. |

**No policy means defaults.** The storefront never creates the policy ConfigMap. Deleting it returns to the defaults.

**Advisory, not a security boundary.** The storefront applies manifests with the logged-in user's own token, so the policy controls what the storefront *offers*, not what that user could apply by hand. For hard limits, use RBAC and the opt-in admission policy pack (`vap/`, coming in a later release).

**If the policy can't be read** (a typo, or the user lacks access), the storefront falls back to the defaults and shows a banner with the reason. It never blocks the whole catalog because of a broken policy.
