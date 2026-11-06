// Package validate checks values that come from callers before a backend uses them
// in API paths, file paths or commands.
package validate

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	dns1123Label     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
)

// DNS1123Label checks a Kubernetes name such as a namespace (max 63 characters).
func DNS1123Label(s string) error {
	if len(s) == 0 || len(s) > 63 || !dns1123Label.MatchString(s) {
		return fmt.Errorf("invalid name %q: use lowercase letters, digits and '-', at most 63 characters", s)
	}
	return nil
}

// DNS1123Subdomain checks most Kubernetes object names (max 253 characters).
func DNS1123Subdomain(s string) error {
	if len(s) == 0 || len(s) > 253 || !dns1123Subdomain.MatchString(s) {
		return fmt.Errorf("invalid name %q: use lowercase letters, digits, '-' and '.', at most 253 characters", s)
	}
	return nil
}

// ProtectedNamespace reports namespaces a tool must never create objects in or delete
// on a caller's say-so: kube-*, openshift*, default and oct-storefront.
func ProtectedNamespace(ns string) bool {
	return ns == "default" || ns == "oct-storefront" || strings.HasPrefix(ns, "kube-") || ns == "kube" ||
		strings.HasPrefix(ns, "openshift")
}

// Namespace checks a caller-supplied namespace: a valid name, not protected, and, when
// allowed is non-empty, matching one of the allowed entries ("prefix-*" globs allowed).
func Namespace(ns string, allowed ...string) error {
	if err := DNS1123Label(ns); err != nil {
		return err
	}
	if ProtectedNamespace(ns) {
		return fmt.Errorf("namespace %q is protected", ns)
	}
	if len(allowed) == 0 {
		return nil
	}
	for _, a := range allowed {
		if a == ns || strings.HasSuffix(a, "*") && strings.HasPrefix(ns, strings.TrimSuffix(a, "*")) {
			return nil
		}
	}
	return fmt.Errorf("namespace %q is not allowed", ns)
}

// SafeJoin joins a caller-supplied relative path to base and fails if the result
// would leave base (.., absolute paths, NUL bytes).
func SafeJoin(base, rel string) (string, error) {
	if strings.ContainsRune(rel, 0) {
		return "", errors.New("path contains a NUL byte")
	}
	if rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, "\\") {
		return "", fmt.Errorf("invalid path %q: must be relative", rel)
	}
	b := filepath.Clean(base)
	p := filepath.Join(b, rel)
	if p != b && !strings.HasPrefix(p, b+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid path %q: leaves %s", rel, b)
	}
	return p, nil
}

// SafeArg checks a caller-supplied command argument: no leading '-' (so it can't be
// read as an option), no NUL or newline.
func SafeArg(s string) error {
	if s == "" {
		return errors.New("empty argument")
	}
	if strings.HasPrefix(s, "-") {
		return fmt.Errorf("argument %q must not start with '-'", s)
	}
	if strings.ContainsAny(s, "\x00\n\r") {
		return fmt.Errorf("argument %q contains a control character", s)
	}
	return nil
}

var shells = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ash": true, "ksh": true}

// ErrShell is returned by Run for `sh -c`-style invocations.
var ErrShell = errors.New("running a shell with -c is not allowed; pass the program and its arguments directly")

// Run executes name with args directly (never through a shell), with a timeout, and
// returns combined output. It refuses `sh -c ...` and similar.
func Run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if shells[filepath.Base(name)] {
		for _, a := range args {
			if strings.HasPrefix(a, "-") && strings.Contains(a, "c") {
				return nil, ErrShell
			}
		}
	}
	if timeout <= 0 {
		timeout = time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
