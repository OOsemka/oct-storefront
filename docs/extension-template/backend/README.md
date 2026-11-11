# Backend starter

A minimal extension backend built on [`backend-security-kit`](../../../backend-security-kit/README.md):

- every route is checked with the **caller's** permissions (SelfSubjectAccessReview) before the handler runs;
- handlers call the API **as the caller** with `auth.UserToken(r.Context())`;
- HTTPS only, with the OpenShift service-ca certificate;
- caller-supplied names are validated.

To use it in your extension:

1. Copy this directory into your repo, delete the `replace` line in `go.mod`, and run `go mod tidy`.
2. Replace the example route and its permission entry with yours: one `auth.Route` per `mux.HandleFunc`.
3. Deploy it with the snippets in `backend-security-kit/manifests/`: the ConsolePlugin proxy with `authorization: UserToken`, the hardened Deployment (with `AUTH_MODE=enforce`: unset means audit) and Service, and the console-only NetworkPolicy.
4. Declare it in your catalog entry: `spec.security.backend: { services: [...], auth: ssar, authModeDefault: enforce }`.

Pin the base image by digest for releases. The ServiceAccount needs RBAC only for background work; requests made on behalf of users run with their own token.
