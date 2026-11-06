# backend-security-kit

The shared security library for OpenShift Community Tools extension backends. It's Go standard library only, so it adds no dependencies to your backend.

**The problem it solves:** the console sends requests from your plugin straight to your backend through the ConsolePlugin proxy. Your backend then acts with **its own** ServiceAccount, which usually has far more access than the person clicking. Without a check, anyone who can open the console (or reach the Service) can use your backend's permissions. The kit makes the backend check **the caller's** permissions on every request.

## What's in it

| Package | What it does |
|---|---|
| `auth` | Per-route permission table. Each request is checked with a SelfSubjectAccessReview made **with the caller's own token**, so the API server decides. Modes `enforce` / `audit` / `off`, a 30-second answer cache, and a runtime override from the cluster policy. |
| `kubeclient` | In-cluster API client that **always** verifies the cluster CA (no skip-verify option), re-reads the rotating ServiceAccount token, and can make calls as the caller. |
| `server` | HTTPS-only server: refuses to start without a certificate, sets timeouts and body limits, removes CORS headers, and serves `/healthz` and `/readyz` on a separate plain port. |
| `validate` | Checks for caller-supplied values: Kubernetes names, protected namespaces (`kube-*`, `openshift*`, `default`, `oct-storefront`), paths that can't escape a directory, command arguments, and running programs without a shell. |
| `manifests/` | YAML snippets: ConsolePlugin proxy with `authorization: UserToken`, a console-only NetworkPolicy, and a hardened backend Deployment/Service. |

## Adopting it

1. **Forward the user's identity.** Add `authorization: UserToken` to your ConsolePlugin proxy (see `manifests/consoleplugin-proxy.yaml`).
2. **Write the permission table**, one entry per route, using the same pattern strings as your `ServeMux`:

   ```go
   authz, err := auth.New(auth.Options{
       Extension: "oct-baremetal",
       Mode:      auth.ModeFromEnv(),
       Client:    client,
       Policy:    policy,
   }, []auth.Route{
       {Pattern: "GET /api/v1/hosts/{ns}", Checks: []auth.Check{
           {Verb: "list", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.PathValue("ns")},
       }},
       {Pattern: "POST /api/v1/hosts/{ns}/{name}", Checks: []auth.Check{
           {Verb: "create", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.PathValue("ns")},
           {Verb: "create", Resource: "secrets", Namespace: auth.PathValue("ns")},
       }},
       {Pattern: "GET /api/v1/images/{file}", Public: true}, // Ironic fetches this without a user
   })
   ```

   Rule of thumb: require what the user would need to do the same thing with `oc`. All checks on a route must pass. A route with no checks must be marked `Public` explicitly; `New` fails otherwise.
3. **Wrap your mux:** `authz.Middleware(mux)`, and serve it with `server.Run` (see `example_test.go`).
4. **Poll the policy** for the admin override: `go auth.NewPolicySource(client, 0, nil).Run(ctx)`.
5. **Validate inputs** you use in names, paths or commands with `validate`.
6. **Apply the manifests:** the serving-cert annotation, the hardened Deployment settings, and the console-only NetworkPolicy.
7. **Declare it** in your catalog entry: `spec.security.backend: { services: [...], auth: ssar, authModeDefault: enforce }`.

Handlers can call the API **as the caller** with `auth.UserToken(r.Context())` and `kubeclient.Client.Do(ctx, method, path, token, body, out)`. Use the ServiceAccount (token `""`) only for background work, and record who asked, for example with the annotation `communitytools.io/requested-by`.

## Modes

| Mode | Missing token | Permission denied | Unmapped route | API server unreachable |
|---|---|---|---|---|
| `enforce` (default) | 401 | 403, with the missing permission in the message | 403 | 503 (fails closed) |
| `audit` | allowed, logged | allowed, logged | allowed, logged | allowed, logged |
| `off` | not checked (local development only; warns at start) | | | |

**Which mode to ship:**

- **New backends** ship `AUTH_MODE=enforce` (the kit's default).
- **Existing backends** adopting the kit ship `AUTH_MODE=audit` and **stay in audit until a cluster admin turns on enforce** for them in the cluster policy (below). Read the logs for "would be denied" and fix the table or the RBAC, so that switching to enforce is safe. Don't change an existing backend's shipped default to enforce yourself.

## Admin override at runtime

A cluster admin sets each extension's mode in the cluster policy (`community-tools-policy` ConfigMap in `oct-storefront`), without redeploying. This is how an existing extension that ships in audit is switched to enforce, and how an enforced one can be dropped to audit if it blocks something it shouldn't:

```yaml
backends:
  oct-baremetal:
    authMode: enforce   # or audit
```

Backends pick it up within about a minute; removing it restores the Deployment's mode. Only `audit` and `enforce` are accepted: **an override can never turn checks off.** Everyone may read the policy ConfigMap, so the backend's ServiceAccount needs no extra RBAC for this.

## What this does not do

- It doesn't replace your ServiceAccount's RBAC. Keep that as small as you can; the kit limits who can **use** it.
- It doesn't protect public routes. Serve as little as possible on them.
- Optional `IdentifyUsers` adds usernames to logs via TokenReview; the ServiceAccount then needs `system:auth-delegator`.

## Developing

```bash
go vet ./... && go test -race ./...
go test -run=XXX -fuzz=FuzzParseBackendOverrides -fuzztime=30s ./auth
```

Tests run against a fake API server (`internal/fakeapi`); no cluster is needed.

## Versioning

Module `github.com/OOsemka/oct-storefront/backend-security-kit`, tagged `backend-security-kit/vX.Y.Z` in the oct-storefront repository. Extensions pin a version in their `go.mod`.
