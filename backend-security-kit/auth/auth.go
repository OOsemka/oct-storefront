// Package auth checks every request to an extension backend against a per-route
// permission table.
//
// The OpenShift console proxy forwards the logged-in user's token when the
// ConsolePlugin proxy sets `authorization: UserToken`. For each request the
// middleware asks the API server, with that token, whether the user may do what the
// route needs (a SelfSubjectAccessReview). The backend's own ServiceAccount needs no
// extra RBAC for this, and the API server's answer is the source of truth.
//
// Modes:
//   - enforce: missing token → 401, denied → 403, unmapped route → 403,
//     API server unreachable → 503 (fails closed).
//   - audit: everything is allowed, and what enforce would have done is logged.
//   - off: no checks (local development only; logged loudly at start).
//
// The mode comes from the AUTH_MODE environment variable (default audit; new
// extensions set enforce in their Deployment). A cluster
// admin can override it per extension at runtime in the cluster policy
// (backends.<extension>.authMode: audit | enforce); see PolicySource.
package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
)

// Mode is how strictly requests are checked.
type Mode string

const (
	Off     Mode = "off"
	Audit   Mode = "audit"
	Enforce Mode = "enforce"
)

// ModeFromEnv reads AUTH_MODE: enforce, audit or off. Unset or invalid values mean
// audit, so a manifest that forgets the variable logs would-be denials instead of
// answering every request with 401/403. New extensions set AUTH_MODE=enforce in their
// Deployment (the template does); existing ones ship audit until an admin enables
// enforce in the cluster policy. An invalid value is logged.
func ModeFromEnv() Mode {
	raw := os.Getenv("AUTH_MODE")
	switch m := Mode(strings.ToLower(strings.TrimSpace(raw))); m {
	case Off, Audit, Enforce:
		return m
	case "":
		return Audit
	}
	slog.Warn("AUTH_MODE has an unknown value; using audit (would-be denials are only logged)", "value", raw)
	return Audit
}

// Extractor reads a value (namespace or name) from a request.
type Extractor func(*http.Request) string

// PathValue reads a {wildcard} from the route pattern.
func PathValue(name string) Extractor {
	return func(r *http.Request) string { return r.PathValue(name) }
}

// ambiguous is returned by Query when the value can't be trusted to be the one the
// handler will act on; check() answers 400 for it.
const ambiguous = "\x00ambiguous"

// Query reads a URL query parameter. It fails closed (400) when the parameter is
// repeated, or when the request carries a form body: r.FormValue prefers a body value
// with the same key, so the handler could act on something other than what was
// checked. Handlers must read the value the same way: r.URL.Query().Get(name).
func Query(name string) Extractor {
	return func(r *http.Request) string {
		vals := r.URL.Query()[name]
		if len(vals) == 0 {
			return ""
		}
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		if len(vals) > 1 || strings.HasPrefix(ct, "application/x-www-form-urlencoded") || strings.HasPrefix(ct, "multipart/form-data") {
			return ambiguous
		}
		return vals[0]
	}
}

// JSONField reads a top-level string field of a JSON request body (up to 1 MiB),
// or def when the field is absent or empty. The body is put back unchanged, so the
// handler decodes exactly the bytes that were checked (encoding/json picks the last
// of duplicate keys in both places). A body that isn't a JSON object fails closed
// (400).
func JSONField(name, def string) Extractor {
	return func(r *http.Request) string {
		if r.Body == nil {
			return def
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(data))
		if err != nil || len(data) > 1<<20 {
			return ambiguous
		}
		if len(bytes.TrimSpace(data)) == 0 {
			return def
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(data, &obj) != nil {
			return ambiguous
		}
		raw, ok := obj[name]
		if !ok {
			return def
		}
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return ambiguous
		}
		if v == "" {
			return def
		}
		return v
	}
}

// Fixed always returns s.
func Fixed(s string) Extractor { return func(*http.Request) string { return s } }

// Check is one permission the caller must have, in Kubernetes RBAC terms.
type Check struct {
	Verb        string
	Group       string // "" is the core API group
	Resource    string
	Subresource string
	// Namespace and Name are optional. A nil Namespace means a cluster-wide check.
	Namespace Extractor
	Name      Extractor
}

func (c Check) String() string {
	g := c.Group
	if g == "" {
		g = "core"
	}
	res := c.Resource
	if c.Subresource != "" {
		res += "/" + c.Subresource
	}
	return fmt.Sprintf("%s %s (%s)", c.Verb, res, g)
}

// Route maps a Go 1.22 ServeMux pattern ("GET /api/v1/hosts/{ns}/{name}") to the
// permissions it needs. All checks must pass. Public routes are never checked: use
// them only for things that must work without a user, such as an image Ironic fetches.
//
// Prefer setting Handler and serving Authorizer.Handler(): then one pattern decides
// both what is checked and what runs, and the table can't drift from the app's
// routes. With Middleware the table and the app's mux are separate and must match.
type Route struct {
	Pattern string
	Checks  []Check
	Public  bool
	// Subtree allows a Public pattern ending in "/" (which matches everything below it).
	// Without it New refuses such patterns: they easily cover routes added later.
	Subtree bool
	Handler http.Handler
}

// Options configure an Authorizer.
type Options struct {
	// Extension is the catalog name, e.g. oct-baremetal. Used for policy overrides and logs.
	Extension string
	// Mode is the Deployment's mode, normally ModeFromEnv().
	Mode Mode
	// Client performs the access reviews.
	Client *kubeclient.Client
	// Policy supplies runtime overrides from the cluster policy (optional).
	Policy *PolicySource
	// CacheTTL for access-review answers (default 30s).
	CacheTTL time.Duration
	// IdentifyUsers adds the username (via TokenReview) to logs. The ServiceAccount then
	// needs the system:auth-delegator ClusterRole.
	IdentifyUsers bool
	Logger        *slog.Logger
}

// Authorizer is the middleware. Create it with New.
type Authorizer struct {
	opts   Options
	routes []Route
	mux    *http.ServeMux
	cache  *cache
	log    *slog.Logger
}

type ctxKey int

const (
	tokenKey ctxKey = iota
	userKey
)

// UserToken returns the caller's token for user-scoped API calls from a handler.
func UserToken(ctx context.Context) string { s, _ := ctx.Value(tokenKey).(string); return s }

// Username returns the caller's username when IdentifyUsers is on, else "".
func Username(ctx context.Context) string { s, _ := ctx.Value(userKey).(string); return s }

// New validates the table and builds the middleware.
func New(opts Options, routes []Route) (a *Authorizer, err error) {
	if opts.Client == nil {
		return nil, errors.New("auth: Options.Client is required")
	}
	if opts.Extension == "" {
		return nil, errors.New("auth: Options.Extension is required")
	}
	switch opts.Mode {
	case Off, Audit, Enforce:
	case "":
		opts.Mode = Enforce
	default:
		return nil, fmt.Errorf("auth: unknown mode %q", opts.Mode)
	}
	if opts.CacheTTL <= 0 {
		opts.CacheTTL = 30 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	a = &Authorizer{opts: opts, routes: routes, mux: http.NewServeMux(), cache: newCache(opts.CacheTTL, 10000), log: opts.Logger}
	withHandler := 0
	for i := range routes {
		rt := routes[i]
		if rt.Handler != nil {
			withHandler++
		}
		if !rt.Public && len(rt.Checks) == 0 {
			return nil, fmt.Errorf("auth: route %q has no checks; add one or mark it Public", rt.Pattern)
		}
		if rt.Public && strings.HasSuffix(rt.Pattern, "/") && !rt.Subtree {
			return nil, fmt.Errorf("auth: public route %q ends in / and so matches every path below it; set Subtree: true if that is intended", rt.Pattern)
		}
		for _, c := range rt.Checks {
			if c.Verb == "" || c.Resource == "" {
				return nil, fmt.Errorf("auth: route %q has a check without Verb or Resource", rt.Pattern)
			}
		}
		if err := a.register(rt); err != nil {
			return nil, err
		}
	}
	if withHandler != 0 && withHandler != len(routes) {
		return nil, errors.New("auth: set Handler on every route or on none (with Handler, serve Authorizer.Handler())")
	}
	if opts.Mode == Off {
		a.log.Warn("AUTH_MODE=off: requests are NOT checked. Use only for local development.", "extension", opts.Extension)
	} else {
		a.log.Info("permission checks active", "extension", opts.Extension, "mode", string(opts.Mode))
	}
	return a, nil
}

type routeKey struct{}

func (a *Authorizer) register(rt Route) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("auth: invalid route pattern %q: %v", rt.Pattern, r)
		}
	}()
	a.mux.Handle(rt.Pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reached only through Middleware, which stores the continuation in the context.
		if next, ok := r.Context().Value(routeKey{}).(func(http.ResponseWriter, *http.Request, Route)); ok {
			next(w, r, rt)
		}
	}))
	return nil
}

// EffectiveMode is the Deployment's mode unless the cluster policy overrides it.
func (a *Authorizer) EffectiveMode() Mode {
	if m, ok := a.opts.Policy.Mode(a.opts.Extension); ok {
		return m
	}
	return a.opts.Mode
}

// Middleware checks each request before it reaches next (the app's own mux, which
// must route the same patterns as the table).
func (a *Authorizer) Middleware(next http.Handler) http.Handler { return a.serve(next) }

// Handler serves the routes' own Handlers after their checks: one pattern decides
// both. Requires Route.Handler on every route.
func (a *Authorizer) Handler() http.Handler { return a.serve(nil) }

var notFound = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeError(w, http.StatusNotFound, "no such route") })

func (a *Authorizer) serve(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := a.EffectiveMode()
		token := bearer(r)
		// The handler never sees the raw header, so it can't log it or copy it onto
		// another request by accident. Code that calls the Kubernetes API as the
		// caller gets the token explicitly from UserToken(ctx).
		if r.Header.Get("Authorization") != "" {
			r = r.Clone(r.Context())
			r.Header.Del("Authorization")
		}
		if token != "" {
			r = r.WithContext(context.WithValue(r.Context(), tokenKey, token))
		}
		if _, pattern := a.mux.Handler(r); pattern == "" {
			fallback := next
			if fallback == nil {
				fallback = notFound
			}
			a.decide(w, r, fallback, mode, http.StatusForbidden, "no permission rule for this route", nil)
			return
		}
		cont := func(w http.ResponseWriter, r *http.Request, rt Route) {
			h := next
			if h == nil {
				h = rt.Handler
			}
			if h == nil {
				writeError(w, http.StatusInternalServerError, "route has no handler")
				return
			}
			a.check(w, r, h, mode, rt, token)
		}
		a.mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), routeKey{}, cont)))
	})
}

func (a *Authorizer) check(w http.ResponseWriter, r *http.Request, next http.Handler, mode Mode, rt Route, token string) {
	if rt.Public || mode == Off {
		next.ServeHTTP(w, r)
		return
	}
	if token == "" {
		a.decide(w, r, next, mode, http.StatusUnauthorized, "no user token (the ConsolePlugin proxy needs authorization: UserToken)", nil)
		return
	}
	if a.opts.IdentifyUsers {
		if u := a.username(r.Context(), token); u != "" {
			r = r.WithContext(context.WithValue(r.Context(), userKey, u))
		}
	}
	for _, c := range rt.Checks {
		ra := kubeclient.ResourceAttributes{Verb: c.Verb, Group: c.Group, Resource: c.Resource, Subresource: c.Subresource}
		if c.Namespace != nil {
			ra.Namespace = c.Namespace(r)
			if ra.Namespace == ambiguous {
				a.decide(w, r, next, mode, http.StatusBadRequest, "ambiguous namespace parameter for permission check "+c.String(), &c)
				return
			}
			if ra.Namespace == "" {
				a.decide(w, r, next, mode, http.StatusBadRequest, "missing namespace for permission check "+c.String(), &c)
				return
			}
		}
		if c.Name != nil {
			ra.Name = c.Name(r)
			if ra.Name == ambiguous {
				a.decide(w, r, next, mode, http.StatusBadRequest, "ambiguous name parameter for permission check "+c.String(), &c)
				return
			}
		}
		allowed, err := a.review(r.Context(), token, ra)
		switch {
		case kubeclient.IsStatus(err, http.StatusUnauthorized):
			a.decide(w, r, next, mode, http.StatusUnauthorized, "the user token was rejected by the API server", &c)
			return
		case err != nil:
			a.log.Error("access review failed", "extension", a.opts.Extension, "error", err)
			a.decide(w, r, next, mode, http.StatusServiceUnavailable, "could not check permissions", &c)
			return
		case !allowed:
			where := "cluster-wide"
			if ra.Namespace != "" {
				where = "in namespace " + ra.Namespace
			}
			a.decide(w, r, next, mode, http.StatusForbidden, fmt.Sprintf("needs %s %s", c.String(), where), &c)
			return
		}
	}
	next.ServeHTTP(w, r)
}

// decide applies the mode to a failed check: enforce answers with code, audit logs and continues.
func (a *Authorizer) decide(w http.ResponseWriter, r *http.Request, next http.Handler, mode Mode, code int, msg string, _ *Check) {
	attrs := []any{"extension", a.opts.Extension, "method", r.Method, "path", r.URL.Path, "status", code, "reason", msg}
	if u := Username(r.Context()); u != "" {
		attrs = append(attrs, "user", u)
	}
	switch mode {
	case Enforce:
		a.log.Info("request denied", attrs...)
		writeError(w, code, msg)
	default:
		if mode == Audit {
			a.log.Warn("audit: request would be denied in enforce mode", attrs...)
		}
		next.ServeHTTP(w, r)
	}
}

func (a *Authorizer) review(ctx context.Context, token string, ra kubeclient.ResourceAttributes) (bool, error) {
	attrs, _ := json.Marshal([]string{ra.Verb, ra.Group, ra.Resource, ra.Subresource, ra.Namespace, ra.Name})
	th := tokenHash(token)
	key := th + "|" + tokenHash(string(attrs))
	if v, ok := a.cache.get(key); ok {
		return v, nil
	}
	// A token the API server rejected stays rejected for the cache TTL, so a client
	// sending made-up tokens costs one access review per token, not one per request.
	rejected := th + "|rejected"
	if _, ok := a.cache.get(rejected); ok {
		return false, &kubeclient.StatusError{Code: http.StatusUnauthorized}
	}
	allowed, _, err := a.opts.Client.SelfSubjectAccessReview(ctx, token, ra)
	if kubeclient.IsStatus(err, http.StatusUnauthorized) {
		a.cache.put(rejected, false)
	}
	if err != nil {
		return false, err
	}
	a.cache.put(key, allowed)
	return allowed, nil
}

func (a *Authorizer) username(ctx context.Context, token string) string {
	key := tokenHash(token) + "|user"
	if v, ok := a.cache.getString(key); ok {
		return v
	}
	u, ok, err := a.opts.Client.TokenReview(ctx, token)
	if err != nil || !ok {
		return ""
	}
	a.cache.putString(key, u)
	return u
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func tokenHash(t string) string {
	s := sha256.Sum256([]byte(t))
	return hex.EncodeToString(s[:])
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": http.StatusText(code), "message": msg})
}

// cache holds access-review answers keyed by token hash and attributes.
type cache struct {
	mu   sync.Mutex
	ttl  time.Duration
	max  int
	data map[string]cacheEntry
}

type cacheEntry struct {
	allowed bool
	text    string
	expires time.Time
}

func newCache(ttl time.Duration, max int) *cache {
	return &cache{ttl: ttl, max: max, data: map[string]cacheEntry{}}
}

func (c *cache) get(k string) (bool, bool) {
	e, ok := c.lookup(k)
	return e.allowed, ok
}

func (c *cache) getString(k string) (string, bool) {
	e, ok := c.lookup(k)
	return e.text, ok
}

func (c *cache) lookup(k string) (cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.data[k]
	if !ok || time.Now().After(e.expires) {
		return cacheEntry{}, false
	}
	return e, true
}

func (c *cache) put(k string, v bool)         { c.store(k, cacheEntry{allowed: v}) }
func (c *cache) putString(k string, v string) { c.store(k, cacheEntry{text: v}) }

func (c *cache) store(k string, e cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if len(c.data) >= c.max {
		for key, old := range c.data {
			if now.After(old.expires) {
				delete(c.data, key)
			}
		}
		// Still full (a flood of fresh tokens or names): drop the entries closest to
		// expiry, a tenth of the cache, instead of wiping everyone's answers.
		if len(c.data) >= c.max {
			type kv struct {
				k string
				t time.Time
			}
			all := make([]kv, 0, len(c.data))
			for key, old := range c.data {
				all = append(all, kv{key, old.expires})
			}
			sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
			for _, e := range all[:len(all)/10+1] {
				delete(c.data, e.k)
			}
		}
	}
	e.expires = now.Add(c.ttl)
	c.data[k] = e
}
