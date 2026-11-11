package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
	"gopkg.in/yaml.v3"
)

const (
	storefrontNS   = "oct-storefront"
	policyCM       = "community-tools-policy"
	cacheCM        = "community-tools-cache"
	extensionID    = "oct-storefront"
	policyCacheTTL = 30 * time.Second
)

// policyClient reads the cluster policy with this service's own account (every
// authenticated user may read it). Nil outside a cluster.
var policyClient *kubeclient.Client

func configMap(verb, name string) auth.Check {
	return auth.Check{Verb: verb, Resource: "configmaps", Namespace: auth.Fixed(storefrontNS), Name: auth.Fixed(name)}
}

// newAuthorizer: reading the catalog or fetching a manifest needs what every
// storefront user has (reading the cluster policy); sending download counts and
// ratings to the public API needs the right to update the storefront's stats,
// like recording them locally. AUTH_MODE=audit by default for this existing
// backend; a cluster admin enables enforce with backends.oct-storefront.authMode.
func newAuthorizer(kc *kubeclient.Client) (*auth.Authorizer, error) {
	policy := auth.NewPolicySource(kc, 0, nil)
	go policy.Run(context.Background())
	read := []auth.Check{configMap("get", policyCM)}
	write := []auth.Check{configMap("update", cacheCM)}
	return auth.New(auth.Options{Extension: extensionID, Mode: auth.ModeFromEnv(), Client: kc, Policy: policy}, []auth.Route{
		{Pattern: "GET /healthz", Public: true},
		{Pattern: "GET /api/v1/public-catalog", Checks: read},
		{Pattern: "GET /api/v1/fetch-yaml", Checks: read},
		{Pattern: "POST /api/v1/stats/download", Checks: write},
		{Pattern: "POST /api/v1/stats/rating", Checks: write},
	})
}

var telemetryCache struct {
	sync.Mutex
	value   string
	err     error
	fetched time.Time
}

// telemetryAllows enforces the cluster policy's telemetry setting here too, not
// only in the browser: download needs full, rating needs full or ratings-only.
// No policy ConfigMap means the default (full); an unreadable or invalid policy
// sends nothing (fails closed).
func telemetryAllows(ctx context.Context, kind string) (bool, string) {
	mode, err := policyTelemetry(ctx)
	if err != nil {
		return false, "telemetry not sent: the cluster policy could not be read (" + err.Error() + ")"
	}
	switch {
	case mode == "full", mode == "ratings-only" && kind == "rating":
		return true, ""
	}
	return false, "telemetry not sent: the cluster policy sets telemetry: " + mode
}

func policyTelemetry(ctx context.Context) (string, error) {
	if policyClient == nil {
		return "full", nil // local development
	}
	telemetryCache.Lock()
	if time.Since(telemetryCache.fetched) < policyCacheTTL {
		v, err := telemetryCache.value, telemetryCache.err
		telemetryCache.Unlock()
		return v, err
	}
	telemetryCache.Unlock()
	// Read without holding the lock, so a slow API server doesn't queue every stats
	// request behind one call; concurrent misses may each read once.
	v, err := readTelemetry(ctx, policyClient)
	telemetryCache.Lock()
	telemetryCache.value, telemetryCache.err, telemetryCache.fetched = v, err, time.Now()
	telemetryCache.Unlock()
	return v, err
}

func readTelemetry(ctx context.Context, kc *kubeclient.Client) (string, error) {
	data, err := kc.GetConfigMap(ctx, storefrontNS, policyCM)
	if kubeclient.IsStatus(err, http.StatusNotFound) {
		return "full", nil
	}
	if err != nil {
		return "", err
	}
	return parseTelemetry(data["policy.yaml"])
}

func parseTelemetry(policyYAML string) (string, error) {
	var doc struct {
		Telemetry *string `yaml:"telemetry"`
	}
	if err := yaml.Unmarshal([]byte(policyYAML), &doc); err != nil {
		return "", err
	}
	if doc.Telemetry == nil {
		return "full", nil
	}
	switch *doc.Telemetry {
	case "full", "ratings-only", "off":
		return *doc.Telemetry, nil
	}
	return "off", nil // an invalid value never sends more than the policy may allow
}
