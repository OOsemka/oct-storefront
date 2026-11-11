package auth_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/internal/fakeapi"
)

// Review finding A2: a Public subtree pattern must be explicit.
func TestPublicSubtreeNeedsOptIn(t *testing.T) {
	_, client := fakeapi.New(t)
	_, err := auth.New(auth.Options{Extension: "oct-test", Client: client}, []auth.Route{{Pattern: "GET /static/", Public: true}})
	if err == nil || !strings.Contains(err.Error(), "Subtree") {
		t.Fatalf("want a Subtree error, got %v", err)
	}
	if _, err := auth.New(auth.Options{Extension: "oct-test", Client: client}, []auth.Route{{Pattern: "GET /static/", Public: true, Subtree: true}}); err != nil {
		t.Fatal(err)
	}
}

// Review finding A2: with Handler, one pattern drives both the check and the dispatch.
func TestHandlerModeRoutesThroughTheTable(t *testing.T) {
	api, client := fakeapi.New(t)
	api.Allow["admin"] = []string{"*"}
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	a, err := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Enforce, Client: client}, []auth.Route{
		{Pattern: "GET /api/v1/nodes", Checks: []auth.Check{{Verb: "list", Resource: "nodes"}}, Handler: ok},
		{Pattern: "GET /healthz", Public: true, Handler: ok},
	})
	if err != nil {
		t.Fatal(err)
	}
	h := a.Handler()
	for _, c := range []struct {
		path, token string
		want        int
	}{
		{"/api/v1/nodes", "admin", 200},
		{"/api/v1/nodes", "", 401},
		{"/healthz", "", 200},
		{"/api/v1/other", "admin", 403},
	} {
		if w := do(h, "GET", c.path, c.token); w.Code != c.want {
			t.Errorf("%s token=%q: got %d want %d", c.path, c.token, w.Code, c.want)
		}
	}
	// Audit mode: an unmapped route still has no handler to reach.
	a2, _ := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Audit, Client: client}, []auth.Route{
		{Pattern: "GET /api/v1/nodes", Checks: []auth.Check{{Verb: "list", Resource: "nodes"}}, Handler: ok},
	})
	if w := do(a2.Handler(), "GET", "/api/v1/other", ""); w.Code != 404 {
		t.Fatalf("audit unmapped: got %d want 404", w.Code)
	}
	if _, err := auth.New(auth.Options{Extension: "oct-test", Client: client}, []auth.Route{
		{Pattern: "GET /a", Checks: []auth.Check{{Verb: "get", Resource: "nodes"}}, Handler: ok},
		{Pattern: "GET /b", Checks: []auth.Check{{Verb: "get", Resource: "nodes"}}},
	}); err == nil {
		t.Fatal("mixing routes with and without Handler should fail")
	}
}

// Review finding A3: the checked query value must be the one the handler acts on.
func TestQueryAmbiguityFailsClosed(t *testing.T) {
	api, client := fakeapi.New(t)
	api.Allow["dev"] = []string{"list baremetalhosts team-a"}
	a, err := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Enforce, Client: client}, []auth.Route{
		{Pattern: "POST /api/v1/do", Checks: []auth.Check{{Verb: "list", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.Query("ns")}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	send := func(url, ct, body string) int {
		r := httptest.NewRequest("POST", url, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer dev")
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := send("/api/v1/do?ns=team-a", "application/json", "{}"); c != 200 {
		t.Fatalf("plain: got %d", c)
	}
	if c := send("/api/v1/do?ns=team-a", "application/x-www-form-urlencoded", "ns=kube-system"); c != 400 {
		t.Fatalf("form body with the same key: got %d want 400", c)
	}
	if c := send("/api/v1/do?ns=team-a&ns=kube-system", "", ""); c != 400 {
		t.Fatalf("repeated key: got %d want 400", c)
	}
}

// Review finding A5: cache keys of different attributes must not collide.
func TestCacheKeysDoNotCollide(t *testing.T) {
	api, client := fakeapi.New(t)
	api.Allow["dev"] = []string{"get baremetalhosts team-a"}
	a, err := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Enforce, Client: client}, []auth.Route{
		{Pattern: "GET /h", Checks: []auth.Check{{Verb: "get", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.Query("ns"), Name: auth.Query("name")}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	first := do(h, "GET", "/h?ns=team-a&name=%7Cz", "dev").Code
	reviews := api.Reviews.Load()
	second := do(h, "GET", "/h?ns=team-a%7C&name=z", "dev").Code
	if api.Reviews.Load() == reviews {
		t.Fatalf("second request reused the first answer (codes %d, %d)", first, second)
	}
}

// JSONField: the checked body value is the one the handler decodes.
func TestJSONFieldChecksTheBodyTheHandlerReads(t *testing.T) {
	api, client := fakeapi.New(t)
	api.Allow["dev"] = []string{"create baremetalhosts team-a"}
	var seen string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Namespace string `json:"namespace"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = body.Namespace
		w.WriteHeader(200)
	})
	a, err := auth.New(auth.Options{Extension: "oct-test", Mode: auth.Enforce, Client: client}, []auth.Route{
		{Pattern: "POST /discover", Handler: h, Checks: []auth.Check{{Verb: "create", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.JSONField("namespace", "")}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	send := func(body string) int {
		r := httptest.NewRequest("POST", "/discover", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer dev")
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w.Code
	}
	if c := send(`{"namespace":"team-a","bmcAddress":"x"}`); c != 200 || seen != "team-a" {
		t.Fatalf("allowed: code %d, handler saw %q", c, seen)
	}
	if c := send(`{"namespace":"kube-system"}`); c != 403 {
		t.Fatalf("other namespace: got %d", c)
	}
	if c := send(`{"bmcAddress":"x"}`); c != 400 {
		t.Fatalf("missing namespace: got %d want 400", c)
	}
	if c := send(`not json`); c != 400 {
		t.Fatalf("not JSON: got %d want 400", c)
	}
	seen = ""
	if c := send(`{"namespace":"kube-system","namespace":"team-a"}`); c != 200 || seen != "team-a" {
		t.Fatalf("duplicate keys must resolve the same way in check and handler: code %d, saw %q", c, seen)
	}
}
