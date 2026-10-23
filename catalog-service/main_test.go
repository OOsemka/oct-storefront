package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCheckFetchURL(t *testing.T) {
	t.Setenv("COMMUNITY_TOOLS_CATALOG_URL", "https://api.octools.net")
	t.Setenv("FETCH_YAML_ALLOWED_HOSTS", "git.example.com, Mirror.Example.org")
	allowed := allowedFetchHosts()
	ok := []string{
		"https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/upgrade.yaml",
		"https://gitlab.com/x/y/-/raw/main/deploy.yaml",
		"https://api.octools.net/v1/whatever",
		"https://git.example.com/a.yaml",
		"https://mirror.example.org:443/a.yaml",
	}
	bad := []string{
		"http://raw.githubusercontent.com/a.yaml",       // plain http
		"https://kubernetes.default.svc/api",            // in-cluster
		"https://169.254.169.254/latest/meta-data",      // metadata
		"https://10.0.0.1/a.yaml",                       // private IP
		"https://raw.githubusercontent.com:8443/a.yaml", // odd port
		"https://user:pw@raw.githubusercontent.com/a",   // credentials
		"https://raw.githubusercontent.com.evil.io/a",   // suffix trick
		"file:///etc/passwd",
		"",
	}
	for _, u := range ok {
		if err := checkFetchURL(u, allowed); err != nil {
			t.Errorf("should allow %q: %v", u, err)
		}
	}
	for _, u := range bad {
		if err := checkFetchURL(u, allowed); err == nil {
			t.Errorf("should reject %q", u)
		}
	}
}

// A redirect from an allowed host to a disallowed one must not be followed.
func TestFetchAllowedBlocksRedirectOffList(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secret"))
	}))
	defer internal.Close()
	redirector := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internal.URL, http.StatusFound)
	}))
	defer redirector.Close()
	host := strings.TrimPrefix(redirector.URL, "https://")
	hostname := host[:strings.LastIndex(host, ":")]
	allowed := map[string]bool{hostname: true}
	// the test server listens on a random port; check the redirect hook only
	client := redirector.Client()
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return checkFetchURL(req.URL.String(), allowed)
	}
	_, err := fetchWith(context.Background(), client, redirector.URL, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "only https") {
		t.Fatalf("redirect to %s should be refused, got %v", internal.URL, err)
	}
}
