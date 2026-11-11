// Package server runs an extension backend's HTTPS server safely by default.
//
//   - TLS only: Run refuses to start without a certificate and key (on OpenShift, use
//     the service-ca annotation `service.beta.openshift.io/serving-cert-secret-name`).
//   - Timeouts and header/body limits, so a slow or huge request can't tie it up.
//   - No CORS: Access-Control-* response headers are removed. The console proxy
//     calls the backend server-to-server, so browsers never need CORS.
//   - An optional plain-HTTP port that serves only /healthz and /readyz for probes.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// Config for Run. Zero values get safe defaults.
type Config struct {
	Addr     string // default ":9443"
	CertFile string // required
	KeyFile  string // required
	// HealthAddr serves only /healthz and /readyz over plain HTTP (default ":8080"; "-" disables).
	HealthAddr string
	Handler    http.Handler
	// Ready reports readiness for /readyz (default: always ready).
	Ready func() bool

	MaxBodyBytes      int64         // default 1 MiB
	ReadHeaderTimeout time.Duration // default 10s
	ReadTimeout       time.Duration // default 60s
	WriteTimeout      time.Duration // default 120s; raise for long downloads
	IdleTimeout       time.Duration // default 120s
	Logger            *slog.Logger
}

// ErrNoTLS is returned when the certificate or key is missing.
var ErrNoTLS = errors.New("server: TLS certificate and key are required (plain HTTP is not supported)")

func (c *Config) defaults() {
	if c.Addr == "" {
		c.Addr = ":9443"
	}
	if c.HealthAddr == "" {
		c.HealthAddr = ":8080"
	}
	if c.MaxBodyBytes <= 0 {
		c.MaxBodyBytes = 1 << 20
	}
	if c.ReadHeaderTimeout <= 0 {
		c.ReadHeaderTimeout = 10 * time.Second
	}
	if c.ReadTimeout <= 0 {
		c.ReadTimeout = 60 * time.Second
	}
	if c.WriteTimeout <= 0 {
		c.WriteTimeout = 120 * time.Second
	}
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = 120 * time.Second
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.Ready == nil {
		c.Ready = func() bool { return true }
	}
}

// Run serves until ctx is done, then shuts down gracefully.
func Run(ctx context.Context, cfg Config) error {
	cfg.defaults()
	if cfg.CertFile == "" || cfg.KeyFile == "" {
		return ErrNoTLS
	}
	for _, f := range []string{cfg.CertFile, cfg.KeyFile} {
		if _, err := os.Stat(f); err != nil {
			return errors.Join(ErrNoTLS, err)
		}
	}
	if cfg.Handler == nil {
		return errors.New("server: Config.Handler is required")
	}
	main := &http.Server{
		Addr:              cfg.Addr,
		Handler:           Harden(cfg.Handler, cfg.MaxBodyBytes),
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		MaxHeaderBytes:    64 << 10,
	}
	servers := []*http.Server{main}
	errc := make(chan error, 2)
	go func() { errc <- main.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile) }()
	if cfg.HealthAddr != "-" {
		health := &http.Server{Addr: cfg.HealthAddr, Handler: HealthHandler(cfg.Ready), ReadHeaderTimeout: 5 * time.Second}
		servers = append(servers, health)
		go func() { errc <- health.ListenAndServe() }()
	}
	cfg.Logger.Info("listening", "https", cfg.Addr, "health", cfg.HealthAddr)

	var err error
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdownCtx)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// HealthHandler serves /healthz (always 200) and /readyz (200 when ready) and nothing else.
func HealthHandler(ready func() bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready != nil && !ready() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

// Harden wraps h with a body-size limit, security headers and CORS removal.
func Harden(h http.Handler, maxBody int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			http.Error(w, "CORS is not supported", http.StatusForbidden)
			return
		}
		if maxBody > 0 && r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		}
		hw := &headerGuard{ResponseWriter: w}
		h.ServeHTTP(hw, r)
	})
}

// headerGuard sets security headers and strips CORS headers before the first write.
type headerGuard struct {
	http.ResponseWriter
	wrote bool
}

func (g *headerGuard) prepare() {
	if g.wrote {
		return
	}
	g.wrote = true
	h := g.ResponseWriter.Header()
	for k := range h {
		if strings.HasPrefix(http.CanonicalHeaderKey(k), "Access-Control-") {
			h.Del(k)
		}
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "no-store")
	}
}

func (g *headerGuard) WriteHeader(code int) {
	g.prepare()
	g.ResponseWriter.WriteHeader(code)
}

func (g *headerGuard) Write(b []byte) (int, error) {
	g.prepare()
	return g.ResponseWriter.Write(b)
}

// Flush supports streaming handlers (e.g. log tails).
func (g *headerGuard) Flush() {
	g.prepare()
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (g *headerGuard) Unwrap() http.ResponseWriter { return g.ResponseWriter }
