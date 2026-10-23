package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxBody = 2 << 20

func main() {
	httpPort := flag.String("http-port", "8080", "HTTP port")
	httpsPort := flag.String("https-port", "8443", "HTTPS port")
	tlsCert := flag.String("tls-cert", "/var/run/secrets/tls/tls.crt", "TLS certificate")
	tlsKey := flag.String("tls-key", "/var/run/secrets/tls/tls.key", "TLS key")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/v1/public-catalog", handlePublicCatalog)
	mux.HandleFunc("GET /api/v1/fetch-yaml", handleFetchYAML)
	mux.HandleFunc("POST /api/v1/stats/download", handlePublicStat("download"))
	mux.HandleFunc("POST /api/v1/stats/rating", handlePublicStat("rating"))

	handler := withCORS(mux)

	go func() {
		addr := ":" + *httpPort
		log.Printf("catalog-service HTTP on %s", addr)
		srv := &http.Server{Addr: addr, Handler: handler, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second}
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("HTTP server: %v", err)
		}
	}()

	if _, err := os.Stat(*tlsCert); err == nil {
		addr := ":" + *httpsPort
		log.Printf("catalog-service HTTPS on %s", addr)
		srv := &http.Server{
			Addr:         addr,
			Handler:      handler,
			TLSConfig:    &tls.Config{MinVersion: tls.VersionTLS12},
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 15 * time.Second,
		}
		log.Fatal(srv.ListenAndServeTLS(*tlsCert, *tlsKey))
	}
	log.Println("TLS cert not found, HTTP only")
	select {}
}

func catalogURL() string {
	for _, key := range []string{"COMMUNITY_TOOLS_CATALOG_URL", "CATALOG_URL"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return ""
}

func handlePublicCatalog(w http.ResponseWriter, r *http.Request) {
	url := catalogURL()
	if url == "" {
		writeJSON(w, map[string]any{"ok": false, "reason": "COMMUNITY_TOOLS_CATALOG_URL is unset"})
		return
	}
	body, err := fetchURL(r.Context(), url, 3*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "reason": err.Error()})
		return
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		writeJSON(w, map[string]any{"ok": false, "reason": "public catalog is not JSON: " + err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "catalog": parsed})
}

// Deploy manifests live on public git hosts. fetch-yaml used to fetch any
// http(s) URL for any console user, which made it a proxy into the cluster
// network (in-cluster Services, node and metadata addresses). It now only
// fetches https URLs on these hosts, the catalog's own host, and whatever an
// admin adds with FETCH_YAML_ALLOWED_HOSTS (comma-separated).
var defaultFetchHosts = []string{"raw.githubusercontent.com", "gitlab.com", "codeberg.org"}

func allowedFetchHosts() map[string]bool {
	hosts := map[string]bool{}
	for _, h := range defaultFetchHosts {
		hosts[h] = true
	}
	if u, err := url.Parse(catalogURL()); err == nil && u.Hostname() != "" {
		hosts[strings.ToLower(u.Hostname())] = true
	}
	for _, h := range strings.Split(os.Getenv("FETCH_YAML_ALLOWED_HOSTS"), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			hosts[h] = true
		}
	}
	return hosts
}

// checkFetchURL accepts only https URLs on an allowed host, on the default
// port, without credentials.
func checkFetchURL(raw string, allowed map[string]bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid url")
	}
	if u.Scheme != "https" {
		return fmt.Errorf("only https URLs are fetched")
	}
	if u.User != nil {
		return fmt.Errorf("URLs with credentials are not fetched")
	}
	if p := u.Port(); p != "" && p != "443" {
		return fmt.Errorf("only the default https port is allowed")
	}
	if !allowed[strings.ToLower(u.Hostname())] {
		return fmt.Errorf("host %q is not allowed (set FETCH_YAML_ALLOWED_HOSTS on catalog-service to add it)", u.Hostname())
	}
	return nil
}

func handleFetchYAML(w http.ResponseWriter, r *http.Request) {
	target := strings.TrimSpace(r.URL.Query().Get("url"))
	allowed := allowedFetchHosts()
	if err := checkFetchURL(target, allowed); err != nil {
		writeJSON(w, map[string]any{"ok": false, "reason": err.Error()})
		return
	}
	body, err := fetchAllowed(r.Context(), target, allowed, 10*time.Second)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "reason": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "yaml": string(body)})
}

func handlePublicStat(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		base := catalogURL()
		if base == "" {
			writeJSON(w, map[string]any{"ok": false, "reason": "COMMUNITY_TOOLS_CATALOG_URL is unset"})
			return
		}
		payload, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		endpoint := strings.TrimRight(base, "/") + "/v1/stats/" + kind
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(payload)))
		if err != nil {
			writeJSON(w, map[string]any{"ok": false, "reason": err.Error()})
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			writeJSON(w, map[string]any{"ok": false, "reason": err.Error()})
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBody))
		writeJSON(w, map[string]any{"ok": resp.StatusCode >= 200 && resp.StatusCode < 300})
	}
}

// fetchAllowed is fetchURL with every redirect held to the same rules.
func fetchAllowed(ctx context.Context, target string, allowed map[string]bool, timeout time.Duration) ([]byte, error) {
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return checkFetchURL(req.URL.String(), allowed)
	}}
	return fetchWith(ctx, client, target, timeout)
}

func fetchURL(ctx context.Context, url string, timeout time.Duration) ([]byte, error) {
	return fetchWith(ctx, http.DefaultClient, url, timeout)
}

func fetchWith(ctx context.Context, client *http.Client, url string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return body, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
