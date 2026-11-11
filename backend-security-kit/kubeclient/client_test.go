package kubeclient_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/internal/fakeapi"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
)

func TestRefusesPlainHTTPAndEmptyCA(t *testing.T) {
	if _, err := kubeclient.New("http://example", []byte("x"), ""); err == nil {
		t.Fatal("expected an error for an empty CA bundle")
	}
	srv, _ := fakeapi.New(t)
	if _, err := kubeclient.New("http://example", pemOf(t, srv), ""); err == nil {
		t.Fatal("expected an error for http://")
	}
}

func TestVerifiesTheServerCertificate(t *testing.T) {
	// A client trusting a different CA must fail the TLS handshake.
	other := httptest.NewTLSServer(nil)
	defer other.Close()
	srv, _ := fakeapi.New(t)
	tokenFile := filepath.Join(t.TempDir(), "t")
	_ = os.WriteFile(tokenFile, []byte("x"), 0o600)
	c, err := kubeclient.New(other.URL, pemOf(t, srv), tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetConfigMap(context.Background(), "a", "b"); err == nil {
		t.Fatal("expected a certificate error")
	}
}

func TestAccessReviewUsesTheCallersToken(t *testing.T) {
	srv, c := fakeapi.New(t)
	srv.Allow["user-1"] = []string{"get nodes "}
	ok, _, err := c.SelfSubjectAccessReview(context.Background(), "user-1", kubeclient.ResourceAttributes{Verb: "get", Resource: "nodes"})
	if err != nil || !ok {
		t.Fatalf("allowed=%v err=%v", ok, err)
	}
	if srv.LastAuth != "user-1" {
		t.Fatalf("review sent with %q, want the caller's token", srv.LastAuth)
	}
	_, _, err = c.SelfSubjectAccessReview(context.Background(), "unknown", kubeclient.ResourceAttributes{Verb: "get", Resource: "nodes"})
	if !kubeclient.IsStatus(err, 401) {
		t.Fatalf("want 401, got %v", err)
	}
	if _, _, err := c.SelfSubjectAccessReview(context.Background(), "", kubeclient.ResourceAttributes{}); err == nil {
		t.Fatal("expected an error without a caller token")
	}
}

func TestServiceAccountCallsAndTokenReview(t *testing.T) {
	srv, c := fakeapi.New(t)
	srv.Users["user-1"] = "alice"
	u, ok, err := c.TokenReview(context.Background(), "user-1")
	if err != nil || !ok || u != "alice" {
		t.Fatalf("u=%q ok=%v err=%v", u, ok, err)
	}
	if srv.LastAuth != srv.SAToken {
		t.Fatalf("TokenReview must use the ServiceAccount token, used %q", srv.LastAuth)
	}
	_, err = c.GetConfigMap(context.Background(), "oct-storefront", "community-tools-policy")
	if !kubeclient.IsStatus(err, 404) {
		t.Fatalf("want 404, got %v", err)
	}
}

// Review finding A1: "as the caller" never falls back to the ServiceAccount.
func TestDoAsUserRefusesAnEmptyToken(t *testing.T) {
	_, c := fakeapi.New(t)
	if err := c.DoAsUser(context.Background(), "GET", "/api/v1/namespaces", "", nil, nil); !errors.Is(err, kubeclient.ErrNoUserToken) {
		t.Fatalf("want ErrNoUserToken, got %v", err)
	}
	if err := c.DoAsUser(context.Background(), "GET", "/api/v1/namespaces", "  ", nil, nil); !errors.Is(err, kubeclient.ErrNoUserToken) {
		t.Fatalf("whitespace token: want ErrNoUserToken, got %v", err)
	}
}
