// Package fakeapi is a tiny fake Kubernetes API server for tests.
package fakeapi

import (
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
)

// Server answers SelfSubjectAccessReviews from Allow, TokenReviews from Users, and
// GETs for the policy ConfigMap from Policy.
type Server struct {
	*httptest.Server
	mu sync.Mutex
	// Allow[token] lists "verb resource namespace" strings the token may do ("*" = all).
	Allow map[string][]string
	// Users maps tokens to usernames for TokenReview.
	Users map[string]string
	// Policy is policy.yaml; nil means the ConfigMap doesn't exist.
	Policy *string
	// Fail makes every review answer 500.
	Fail     bool
	Reviews  atomic.Int64
	SAToken  string
	LastAuth string
}

// New starts a server and returns it with a client that trusts it.
func New(t *testing.T) (*Server, *kubeclient.Client) {
	t.Helper()
	s := &Server{Allow: map[string][]string{}, Users: map[string]string{}, SAToken: "sa-token"}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.Close)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw})
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(s.SAToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := kubeclient.New(s.URL, ca, tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	return s, c
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := ""
	if h := r.Header.Get("Authorization"); len(h) > 7 {
		tok = h[7:]
	}
	s.LastAuth = tok
	switch r.URL.Path {
	case "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews":
		s.Reviews.Add(1)
		if s.Fail {
			http.Error(w, `{"message":"boom"}`, 500)
			return
		}
		perms, known := s.Allow[tok]
		if !known {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"message":"Unauthorized"}`))
			return
		}
		var req struct {
			Spec struct {
				ResourceAttributes kubeclient.ResourceAttributes `json:"resourceAttributes"`
			} `json:"spec"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		ra := req.Spec.ResourceAttributes
		want := ra.Verb + " " + ra.Resource + " " + ra.Namespace
		allowed := false
		for _, p := range perms {
			if p == "*" || p == want {
				allowed = true
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"allowed": allowed}})
	case "/apis/authentication.k8s.io/v1/tokenreviews":
		var req struct {
			Spec struct {
				Token string `json:"token"`
			} `json:"spec"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		u, ok := s.Users[req.Spec.Token]
		_ = json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"authenticated": ok, "user": map[string]any{"username": u}}})
	case "/api/v1/namespaces/oct-storefront/configmaps/community-tools-policy":
		if s.Policy == nil {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"policy.yaml": *s.Policy}})
	default:
		http.NotFound(w, r)
	}
}

// SetPolicy sets or clears policy.yaml.
func (s *Server) SetPolicy(p *string) { s.mu.Lock(); s.Policy = p; s.mu.Unlock() }
