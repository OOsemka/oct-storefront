package server_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/server"
)

func TestRunRefusesPlaintext(t *testing.T) {
	err := server.Run(context.Background(), server.Config{Handler: http.NotFoundHandler()})
	if !errors.Is(err, server.ErrNoTLS) {
		t.Fatalf("got %v", err)
	}
	err = server.Run(context.Background(), server.Config{Handler: http.NotFoundHandler(), CertFile: "/nope/tls.crt", KeyFile: "/nope/tls.key"})
	if !errors.Is(err, server.ErrNoTLS) {
		t.Fatalf("missing files: got %v", err)
	}
}

func TestHardenStripsCORSAndSetsHeaders(t *testing.T) {
	h := server.Harden(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("access-control-allow-methods", "GET")
		_, _ = w.Write([]byte("hi"))
	}), 1<<20)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("Access-Control-Allow-Methods") != "" {
		t.Fatalf("CORS headers not removed: %v", w.Header())
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing security headers: %v", w.Header())
	}
	pre := httptest.NewRequest("OPTIONS", "/", nil)
	pre.Header.Set("Access-Control-Request-Method", "POST")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, pre)
	if w.Code != 403 {
		t.Fatalf("preflight: got %d", w.Code)
	}
}

func TestHardenLimitsBodies(t *testing.T) {
	h := server.Harden(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			http.Error(w, "too big", http.StatusRequestEntityTooLarge)
		}
	}), 10)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", strings.NewReader(strings.Repeat("x", 100))))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d", w.Code)
	}
}

func TestHealthHandlerServesOnlyProbes(t *testing.T) {
	ready := false
	h := server.HealthHandler(func() bool { return ready })
	check := func(path string, want int) {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != want {
			t.Fatalf("%s: got %d want %d", path, w.Code, want)
		}
	}
	check("/healthz", 200)
	check("/readyz", 503)
	ready = true
	check("/readyz", 200)
	check("/api/v1/anything", 404)
}
