package auth

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/OOsemka/oct-storefront/backend-security-kit/kubeclient"
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
// Only audit and enforce are accepted; an override can never turn checks off.
// Every authenticated user may read the policy ConfigMap, so the backend's
// ServiceAccount needs no extra RBAC.
type PolicySource struct {
	client   *kubeclient.Client
	interval time.Duration
	log      *slog.Logger

	mu    sync.RWMutex
	modes map[string]Mode
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
	p.Set(ParseBackendOverrides(data[PolicyKey]))
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

// ParseBackendOverrides extracts backends.<name>.authMode from policy.yaml.
//
// The kit is standard library only, so this reads just the small YAML subset the
// `backends` section uses: a block mapping of names, each with `authMode: <mode>`
// on the next line or as a flow mapping `{ authMode: <mode> }`, or the whole section
// as a flow mapping. Anything else is ignored. It never panics.
func ParseBackendOverrides(policyYAML string) map[string]Mode {
	out := map[string]Mode{}
	lines := strings.Split(strings.ReplaceAll(policyYAML, "\r\n", "\n"), "\n")
	for i := 0; i < len(lines); i++ {
		line := stripComment(lines[i])
		if indentOf(line) != 0 || !strings.HasPrefix(line, "backends:") {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, "backends:"))
		if strings.HasPrefix(rest, "{") {
			parseFlowBackends(rest, out)
			return out
		}
		childIndent := -1
		current := ""
		for j := i + 1; j < len(lines); j++ {
			l := stripComment(lines[j])
			if strings.TrimSpace(l) == "" {
				continue
			}
			ind := indentOf(l)
			if ind == 0 {
				break
			}
			key, val, ok := splitKV(strings.TrimSpace(l))
			if !ok {
				continue
			}
			if childIndent < 0 {
				childIndent = ind
			}
			switch {
			case ind == childIndent:
				current = key
				if strings.HasPrefix(val, "{") {
					if m, ok := flowAuthMode(val); ok {
						out[current] = m
					}
				}
			case ind > childIndent && current != "" && key == "authMode":
				if m, ok := asOverride(val); ok {
					out[current] = m
				}
			}
		}
		return out
	}
	return out
}

// parseFlowBackends handles `backends: { a: { authMode: audit }, b: { authMode: enforce } }`.
func parseFlowBackends(s string, out map[string]Mode) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return
	}
	body := s[1 : len(s)-1]
	for len(body) > 0 {
		colon := strings.Index(body, ":")
		if colon < 0 {
			return
		}
		name := unquote(strings.TrimSpace(strings.TrimLeft(body[:colon], ", ")))
		rest := strings.TrimSpace(body[colon+1:])
		if !strings.HasPrefix(rest, "{") {
			return
		}
		end := strings.Index(rest, "}")
		if end < 0 {
			return
		}
		if m, ok := flowAuthMode(rest[:end+1]); ok && name != "" {
			out[name] = m
		}
		body = rest[end+1:]
	}
}

// flowAuthMode reads `{ authMode: audit }`.
func flowAuthMode(s string) (Mode, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return "", false
	}
	for _, part := range strings.Split(s[1:len(s)-1], ",") {
		if k, v, ok := splitKV(strings.TrimSpace(part)); ok && k == "authMode" {
			return asOverride(v)
		}
	}
	return "", false
}

func asOverride(v string) (Mode, bool) {
	switch Mode(unquote(v)) {
	case Audit:
		return Audit, true
	case Enforce:
		return Enforce, true
	}
	return "", false
}

func splitKV(s string) (string, string, bool) {
	i := strings.Index(s, ":")
	if i <= 0 {
		return "", "", false
	}
	return unquote(strings.TrimSpace(s[:i])), strings.TrimSpace(s[i+1:]), true
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '"' && s[len(s)-1] == '"' || s[0] == '\'' && s[len(s)-1] == '\'') {
		return s[1 : len(s)-1]
	}
	return s
}

func stripComment(l string) string {
	if i := strings.Index(l, "#"); i >= 0 && (i == 0 || l[i-1] == ' ' || l[i-1] == '\t') {
		l = l[:i]
	}
	return strings.TrimRight(l, " \t")
}

func indentOf(l string) int {
	return len(l) - len(strings.TrimLeft(l, " "))
}
