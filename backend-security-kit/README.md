# backend-security-kit

The shared security library for OpenShift Community Tools extension backends. Its only dependency is `gopkg.in/yaml.v3`, so it reads the cluster policy exactly as the storefront does.

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

1. **Forward the user's identity.** Add `authorization: UserToken` to your ConsolePlugin proxy (see `manifests/consoleplugin-proxy.yaml`). Your backend then receives every caller's OpenShift token. The middleware removes the `Authorization` header before your handler runs, so it can't be logged or copied onto another request by accident. To call the Kubernetes API as the caller (as the template does), read it explicitly with `auth.UserToken(r.Context())`. Never log or store the token, and never send it anywhere except the cluster's Kubernetes API.
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
3. **Serve the table:** give every `auth.Route` its `Handler` and serve `authz.Handler()` with `server.Run`, so one pattern decides both the check and what runs. (`authz.Middleware(mux)` also works, but then the table and your mux must stay identical by hand.) A public route ending in `/` matches everything below it, so `New` refuses it unless you set `Subtree: true`. `auth.Query(name)` fails closed (400) if the parameter is repeated or the request has a form body; read it in the handler the same way, `r.URL.Query().Get(name)`, never `r.FormValue`.
4. **Poll the policy** for the admin override: `go auth.NewPolicySource(client, 0, nil).Run(ctx)`.
5. **Validate inputs** you use in names, paths or commands with `validate`.
6. **Apply the manifests:** the serving-cert annotation, the hardened Deployment settings, and the console-only NetworkPolicy.
7. **Declare it** in your catalog entry: `spec.security.backend: { services: [...], auth: ssar, authModeDefault: enforce }`.

Handlers call the API **as the caller** with `client.DoAsUser(ctx, method, path, auth.UserToken(r.Context()), body, out)`. It returns `kubeclient.ErrNoUserToken` when there is no token (possible in audit mode or on a public route) and never falls back to the ServiceAccount; answer 401 then. Use `client.DoAsServiceAccount` only after the caller was checked, for things the caller can't do directly, and record who asked, for example with the annotation `communitytools.io/requested-by`.

## Modes

| Mode | Missing token | Permission denied | Unmapped route | API server unreachable |
|---|---|---|---|---|
| `enforce` (default) | 401 | 403, with the missing permission in the message | 403 | 503 (fails closed) |
| `audit` | allowed, logged | allowed, logged | allowed, logged | allowed, logged |
| `off` | not checked (local development only; warns at start) | | | |

**Which mode to ship:**

- **New backends** ship `AUTH_MODE=enforce`, set explicitly in the Deployment (see `manifests/backend-deployment-snippet.yaml`). When the variable is unset or invalid, the kit uses `audit` (and logs an invalid value), so a manifest that forgets it never turns a tool into 401s.
- **Existing backends** adopting the kit ship `AUTH_MODE=audit` and **stay in audit until a cluster admin turns on enforce** for them in the cluster policy (below). Read the logs for "would be denied" and fix the table or the RBAC, so that switching to enforce is safe. Don't change an existing backend's shipped default to enforce yourself.

## Admin override at runtime

A cluster admin sets each extension's mode in the cluster policy (`community-tools-policy` ConfigMap in `oct-storefront`), without redeploying. This is how an existing extension that ships in audit is switched to enforce, and how an enforced one can be dropped to audit if it blocks something it shouldn't:

```yaml
backends:
  oct-baremetal:
    authMode: enforce   # or audit
```

Backends pick it up within about a minute; removing it restores the Deployment's mode. Only `audit` and `enforce` are accepted, so an override can't select `off`. But **audit lets every request through** (it only logs), so who may edit that ConfigMap matters: by default only cluster admins. Invalid entries are logged as warnings and ignored. Everyone may read the policy ConfigMap, so the backend's ServiceAccount needs no extra RBAC for this.

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

Module `github.com/openshift-community-tools/oct-storefront/backend-security-kit`, tagged `backend-security-kit/vX.Y.Z` in the oct-storefront repository. Extensions pin a version in their `go.mod`.
