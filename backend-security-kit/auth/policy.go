package auth

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
)

// The cluster policy written by cluster admins (see oct-storefront docs/security-model.md).
const (
	PolicyNamespace = "oct-storefront"
	PolicyConfigMap = "community-tools-policy"
	PolicyKey       = "policy.yaml"
)

// PolicySource polls the cluster policy for runtime auth-mode overrides:
//
//	backends:
//	  oct-baremetal:
//	    authMode: audit
//
// Only audit and enforce are accepted; an override can never turn checks off. Note
// that audit lets every request through (it only logs), so who may edit the policy
// ConfigMap matters: cluster admins, and anyone bound to the admin or edit role in
// the oct-storefront namespace. Keep those bindings to people who may change
// security settings.
// Every authenticated user may read the policy ConfigMap, so the backend's
// ServiceAccount needs no extra RBAC.
type PolicySource struct {
	client   *kubeclient.Client
	interval time.Duration
	log      *slog.Logger

	mu       sync.RWMutex
	modes    map[string]Mode
	lastWarn string
}

// NewPolicySource creates a source that polls every interval (60s when zero).
func NewPolicySource(client *kubeclient.Client, interval time.Duration, log *slog.Logger) *PolicySource {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	return &PolicySource{client: client, interval: interval, log: log, modes: map[string]Mode{}}
}

// Mode returns the override for an extension, if the policy sets one.
func (p *PolicySource) Mode(extension string) (Mode, bool) {
	if p == nil {
		return "", false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	m, ok := p.modes[extension]
	return m, ok
}

// Set replaces the overrides (used by Refresh and tests).
func (p *PolicySource) Set(modes map[string]Mode) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.modes = modes
}

// Refresh reads the policy once. A missing policy clears the overrides; any other
// error keeps the last known overrides.
func (p *PolicySource) Refresh(ctx context.Context) error {
	data, err := p.client.GetConfigMap(ctx, PolicyNamespace, PolicyConfigMap)
	if kubeclient.IsStatus(err, 404) {
		p.Set(map[string]Mode{})
		return nil
	}
	if err != nil {
		return err
	}
	modes, warns := ParseBackendOverridesWarn(data[PolicyKey])
	p.Set(modes)
	if w := strings.Join(warns, "; "); w != p.lastWarn {
		p.lastWarn = w
		if w != "" {
			p.log.Warn("cluster policy: problems in backends", "problems", w)
		}
	}
	return nil
}

// Run polls until ctx is done.
func (p *PolicySource) Run(ctx context.Context) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		if err := p.Refresh(ctx); err != nil && ctx.Err() == nil {
			p.log.Warn("could not read the cluster policy; keeping the last auth-mode overrides", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ParseBackendOverrides extracts backends.<name>.authMode from policy.yaml with a
// real YAML parser, so the kit reads the policy exactly as the storefront's policy
// page does. Invalid YAML or invalid entries yield no override for them (the
// Deployment's own mode applies); ParseBackendOverridesWarn also says why.
func ParseBackendOverrides(policyYAML string) map[string]Mode {
	m, _ := ParseBackendOverridesWarn(policyYAML)
	return m
}

// ParseBackendOverridesWarn is ParseBackendOverrides plus the problems found.
func ParseBackendOverridesWarn(policyYAML string) (map[string]Mode, []string) {
	out := map[string]Mode{}
	text := strings.TrimPrefix(policyYAML, "\ufeff")
	if strings.TrimSpace(text) == "" {
		return out, nil
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return out, []string{"policy.yaml is not valid YAML (" + err.Error() + "); no auth-mode overrides apply"}
	}
	raw, ok := doc["backends"]
	if !ok || raw == nil {
		return out, nil
	}
	backends, ok := raw.(map[string]any)
	if !ok {
		return out, []string{"backends must be a mapping of extension names; no auth-mode overrides apply"}
	}
	var warns []string
	for name, v := range backends {
		entry, ok := v.(map[string]any)
		if !ok {
			warns = append(warns, "backends."+name+" must be a mapping with authMode; ignored")
			continue
		}
		am, ok := entry["authMode"]
		if !ok {
			warns = append(warns, "backends."+name+" has no authMode; ignored")
			continue
		}
		str, _ := am.(string)
		mode, ok := asOverride(str)
		if !ok {
			warns = append(warns, fmt.Sprintf("backends.%s.authMode %q is not audit or enforce; ignored", name, am))
			continue
		}
		out[name] = mode
	}
	sort.Strings(warns)
	return out, warns
}

func asOverride(v string) (Mode, bool) {
	switch Mode(strings.ToLower(strings.TrimSpace(v))) {
	case Audit:
		return Audit, true
	case Enforce:
		return Enforce, true
	}
	return "", false
}
