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
// The mode comes from the AUTH_MODE environment variable (default enforce). A cluster
// admin can override it per extension at runtime in the cluster policy
// (backends.<extension>.authMode: audit | enforce); see PolicySource.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/OOsemka/oct-storefront/backend-security-kit/kubeclient"
)

// Mode is how strictly requests are checked.
type Mode string

const (
	Off     Mode = "off"
	Audit   Mode = "audit"
	Enforce Mode = "enforce"
)

// ModeFromEnv reads AUTH_MODE. Unset or invalid values mean enforce.
func ModeFromEnv() Mode {
	switch Mode(strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_MODE")))) {
	case Off:
		return Off
	case Audit:
		return Audit
	}
	return Enforce
}

// Extractor reads a value (namespace or name) from a request.
type Extractor func(*http.Request) string

// PathValue reads a {wildcard} from the route pattern.
func PathValue(name string) Extractor {
	return func(r *http.Request) string { return r.PathValue(name) }
}

// Query reads a query parameter.
func Query(name string) Extractor {
	return func(r *http.Request) string { return r.URL.Query().Get(name) }
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
type Route struct {
	Pattern string
	Checks  []Check
	Public  bool
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
	for i := range routes {
		rt := routes[i]
		if !rt.Public && len(rt.Checks) == 0 {
			return nil, fmt.Errorf("auth: route %q has no checks; add one or mark it Public", rt.Pattern)
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
	if opts.Mode == Off {
		a.log.Warn("AUTH_MODE=off: requests are NOT checked. Use only for local development.", "extension", opts.Extension)
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

// Middleware checks each request before it reaches next.
func (a *Authorizer) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := a.EffectiveMode()
		token := bearer(r)
		if token != "" {
			r = r.WithContext(context.WithValue(r.Context(), tokenKey, token))
		}
		if _, pattern := a.mux.Handler(r); pattern == "" {
			a.decide(w, r, next, mode, http.StatusForbidden, "no permission rule for this route", nil)
			return
		}
		cont := func(w http.ResponseWriter, r *http.Request, rt Route) { a.check(w, r, next, mode, rt, token) }
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
			if ra.Namespace == "" {
				a.decide(w, r, next, mode, http.StatusBadRequest, "missing namespace for permission check "+c.String(), &c)
				return
			}
		}
		if c.Name != nil {
			ra.Name = c.Name(r)
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
	key := tokenHash(token) + "|" + ra.Verb + "|" + ra.Group + "|" + ra.Resource + "|" + ra.Subresource + "|" + ra.Namespace + "|" + ra.Name
	if v, ok := a.cache.get(key); ok {
		return v, nil
	}
	allowed, _, err := a.opts.Client.SelfSubjectAccessReview(ctx, token, ra)
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
		if len(c.data) >= c.max {
			c.data = map[string]cacheEntry{}
		}
	}
	e.expires = now.Add(c.ttl)
	c.data[k] = e
}
