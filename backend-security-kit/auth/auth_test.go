package auth_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/internal/fakeapi"
)

var routes = []auth.Route{
	{Pattern: "GET /api/v1/hosts/{ns}", Checks: []auth.Check{{Verb: "list", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.PathValue("ns")}}},
	{Pattern: "POST /api/v1/hosts/{ns}/{name}", Checks: []auth.Check{
		{Verb: "create", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.PathValue("ns")},
		{Verb: "create", Resource: "secrets", Namespace: auth.PathValue("ns")},
	}},
	{Pattern: "GET /api/v1/nodes", Checks: []auth.Check{{Verb: "list", Resource: "nodes"}}},
	{Pattern: "GET /images/{file}", Public: true},
}

type setup struct {
	api  *fakeapi.Server
	a    *auth.Authorizer
	h    http.Handler
	logs *bytes.Buffer
}

func newSetup(t *testing.T, mode auth.Mode, policy *auth.PolicySource) setup {
	t.Helper()
	api, client := fakeapi.New(t)
	logs := &bytes.Buffer{}
	a, err := auth.New(auth.Options{
		Extension: "oct-test", Mode: mode, Client: client, Policy: policy, IdentifyUsers: true,
		Logger: slog.New(slog.NewTextHandler(logs, nil)),
	}, routes)
	if err != nil {
		t.Fatal(err)
	}
	app := http.NewServeMux()
	app.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-User", auth.Username(r.Context()))
		w.Header().Set("X-Has-Token", map[bool]string{true: "yes", false: "no"}[auth.UserToken(r.Context()) != ""])
		w.Header().Set("X-Raw-Authorization", map[bool]string{true: "yes", false: "no"}[r.Header.Get("Authorization") != ""])
		w.WriteHeader(200)
	})
	return setup{api: api, a: a, h: a.Middleware(app), logs: logs}
}

func do(h http.Handler, method, path, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestEnforce(t *testing.T) {
	s := newSetup(t, auth.Enforce, nil)
	s.api.Allow["admin"] = []string{"*"}
	s.api.Allow["dev"] = []string{"list baremetalhosts team-a"}
	s.api.Users["admin"] = "alice"

	cases := []struct {
		name, method, path, token string
		want                      int
	}{
		{"allowed admin", "GET", "/api/v1/hosts/team-a", "admin", 200},
		{"allowed namespaced", "GET", "/api/v1/hosts/team-a", "dev", 200},
		{"denied other namespace", "GET", "/api/v1/hosts/team-b", "dev", 403},
		{"denied cluster-wide", "GET", "/api/v1/nodes", "dev", 403},
		{"all checks must pass", "POST", "/api/v1/hosts/team-a/h1", "dev", 403},
		{"no token", "GET", "/api/v1/nodes", "", 401},
		{"rejected token", "GET", "/api/v1/nodes", "bogus", 401},
		{"unmapped route", "GET", "/api/v1/secret-stuff", "admin", 403},
		{"wrong method is unmapped", "DELETE", "/api/v1/nodes", "admin", 403},
		{"public route without token", "GET", "/images/rhcos.iso", "", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(s.h, c.method, c.path, c.token)
			if w.Code != c.want {
				t.Fatalf("got %d, want %d (%s)", w.Code, c.want, w.Body.String())
			}
		})
	}
	if w := do(s.h, "GET", "/api/v1/nodes", "admin"); w.Header().Get("X-User") != "alice" || w.Header().Get("X-Has-Token") != "yes" {
		t.Fatalf("handler context: user=%q token=%q", w.Header().Get("X-User"), w.Header().Get("X-Has-Token"))
	}
	if w := do(s.h, "GET", "/api/v1/nodes", "dev"); !strings.Contains(w.Body.String(), "needs list nodes (core) cluster-wide") {
		t.Fatalf("403 body should explain the missing permission: %s", w.Body.String())
	}
}

func TestHandlerNeverSeesTheRawToken(t *testing.T) {
	for _, mode := range []auth.Mode{auth.Enforce, auth.Audit, auth.Off} {
		s := newSetup(t, mode, nil)
		s.api.Allow["admin"] = []string{"*"}
		for _, path := range []string{"/api/v1/nodes", "/images/rhcos.iso"} {
			w := do(s.h, "GET", path, "admin")
			if w.Code != 200 {
				t.Fatalf("%s %s: got %d", mode, path, w.Code)
			}
			if got := w.Header().Get("X-Raw-Authorization"); got != "no" {
				t.Fatalf("%s %s: handler saw the Authorization header", mode, path)
			}
			if got := w.Header().Get("X-Has-Token"); got != "yes" {
				t.Fatalf("%s %s: UserToken(ctx) should still return the token", mode, path)
			}
		}
	}
}

func TestEnforceFailsClosedWhenTheAPIIsDown(t *testing.T) {
	s := newSetup(t, auth.Enforce, nil)
	s.api.Allow["admin"] = []string{"*"}
	s.api.Fail = true
	if w := do(s.h, "GET", "/api/v1/nodes", "admin"); w.Code != 503 {
		t.Fatalf("got %d, want 503", w.Code)
	}
}

func TestAuditAllowsAndLogs(t *testing.T) {
	s := newSetup(t, auth.Audit, nil)
	s.api.Allow["dev"] = []string{}
	for _, p := range []string{"/api/v1/nodes", "/api/v1/unmapped"} {
		if w := do(s.h, "GET", p, "dev"); w.Code != 200 {
			t.Fatalf("%s: audit must allow, got %d", p, w.Code)
		}
	}
	if w := do(s.h, "GET", "/api/v1/nodes", ""); w.Code != 200 {
		t.Fatalf("audit must allow without a token, got %d", w.Code)
	}
	if n := strings.Count(s.logs.String(), "would be denied"); n != 3 {
		t.Fatalf("want 3 audit log lines, got %d:\n%s", n, s.logs.String())
	}
}

func TestOffSkipsChecks(t *testing.T) {
	s := newSetup(t, auth.Off, nil)
	if w := do(s.h, "GET", "/api/v1/nodes", ""); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	if s.api.Reviews.Load() != 0 {
		t.Fatal("off must not call the API")
	}
	if !strings.Contains(s.logs.String(), "NOT checked") {
		t.Fatal("off must warn at start")
	}
}

func TestCacheAvoidsRepeatReviews(t *testing.T) {
	s := newSetup(t, auth.Enforce, nil)
	s.api.Allow["admin"] = []string{"*"}
	for i := 0; i < 5; i++ {
		do(s.h, "GET", "/api/v1/nodes", "admin")
	}
	if n := s.api.Reviews.Load(); n != 1 {
		t.Fatalf("want 1 review, got %d", n)
	}
	do(s.h, "GET", "/api/v1/hosts/team-a", "admin")
	if n := s.api.Reviews.Load(); n != 2 {
		t.Fatalf("different attributes need a new review, got %d", n)
	}
}

func TestRejectedTokenIsCached(t *testing.T) {
	s := newSetup(t, auth.Enforce, nil)
	for i := 0; i < 5; i++ {
		if w := do(s.h, "GET", "/api/v1/nodes", "bogus"); w.Code != 401 {
			t.Fatalf("rejected token: got %d", w.Code)
		}
		do(s.h, "GET", "/api/v1/hosts/team-a", "bogus") // other attributes, same token
	}
	if n := s.api.Reviews.Load(); n != 1 {
		t.Fatalf("a rejected token should cost one review, got %d", n)
	}
}

func TestModeIsLoggedAtStart(t *testing.T) {
	s := newSetup(t, auth.Audit, nil)
	if !strings.Contains(s.logs.String(), "permission checks active") || !strings.Contains(s.logs.String(), "audit") {
		t.Fatalf("start log missing the mode: %s", s.logs.String())
	}
}

func TestPolicyOverrideAtRuntime(t *testing.T) {
	api, client := fakeapi.New(t)
	policy := auth.NewPolicySource(client, 0, nil)
	a, err := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Enforce, Client: client, Policy: policy}, routes)
	if err != nil {
		t.Fatal(err)
	}
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	api.Allow["dev"] = []string{}

	if w := do(h, "GET", "/api/v1/nodes", "dev"); w.Code != 403 {
		t.Fatalf("enforce: got %d", w.Code)
	}
	p := "backends:\n  oct-test:\n    authMode: audit\n"
	api.SetPolicy(&p)
	if err := policy.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.EffectiveMode() != auth.Audit {
		t.Fatalf("mode %s", a.EffectiveMode())
	}
	if w := do(h, "GET", "/api/v1/nodes", "dev"); w.Code != 200 {
		t.Fatalf("admin override to audit: got %d", w.Code)
	}
	api.SetPolicy(nil) // policy deleted: back to the Deployment's mode
	if err := policy.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := do(h, "GET", "/api/v1/nodes", "dev"); w.Code != 403 {
		t.Fatalf("after the policy is removed: got %d", w.Code)
	}
	off := "backends:\n  oct-test: { authMode: off }\n"
	api.SetPolicy(&off)
	_ = policy.Refresh(context.Background())
	if a.EffectiveMode() != auth.Enforce {
		t.Fatal("an override can never turn checks off")
	}
}

func TestNewRejectsBadTables(t *testing.T) {
	_, client := fakeapi.New(t)
	bad := [][]auth.Route{
		{{Pattern: "GET /x"}},
		{{Pattern: "GET /x", Checks: []auth.Check{{Verb: "get"}}}},
		{{Pattern: "GET /x", Public: true}, {Pattern: "GET /x", Public: true}},
		{{Pattern: "BAD PATTERN WITH SPACES", Public: true}},
	}
	for i, rt := range bad {
		if _, err := auth.New(auth.Options{Extension: "x", Client: client}, rt); err == nil {
			t.Errorf("table %d: expected an error", i)
		}
	}
	if _, err := auth.New(auth.Options{Extension: "x"}, nil); err == nil {
		t.Error("missing client must fail")
	}
}

func TestModeFromEnv(t *testing.T) {
	for in, want := range map[string]auth.Mode{"": auth.Audit, "audit": auth.Audit, "OFF": auth.Off, " Enforce ": auth.Enforce, "nonsense": auth.Audit} {
		t.Setenv("AUTH_MODE", in)
		if got := auth.ModeFromEnv(); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
}
