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
// would leave base: "..", absolute paths, NUL bytes, or a symlink inside base that
// points outside it (checked for the part of the path that exists now). A symlink
// created after the check is not caught; for directories other users can write to,
// open files through os.Root (Go 1.24+).
func SafeJoin(base, rel string) (string, error) {
	if strings.ContainsRune(rel, 0) {
		return "", errors.New("path contains a NUL byte")
	}
	if rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, "\\") {
		return "", fmt.Errorf("invalid path %q: must be relative", rel)
	}
	b := filepath.Clean(base)
	p := filepath.Join(b, rel)
	if !within(b, p) {
		return "", fmt.Errorf("invalid path %q: leaves %s", rel, b)
	}
	if !within(resolveExisting(b), resolveExisting(p)) {
		return "", fmt.Errorf("invalid path %q: a symlink leads outside %s", rel, b)
	}
	return p, nil
}

func within(base, p string) bool {
	if p == base {
		return true
	}
	prefix := base
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(p, prefix)
}

// resolveExisting resolves symlinks in the longest prefix of p that exists.
func resolveExisting(p string) string {
	rest := ""
	cur := p
	for {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
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

// wrappers run another program given as an argument.
var wrappers = map[string]bool{"env": true, "busybox": true, "sudo": true, "nice": true, "nohup": true, "timeout": true, "xargs": true, "stdbuf": true, "setsid": true}

// ErrShell is returned by Run for `sh -c`-style invocations.
var ErrShell = errors.New("running a shell with -c is not allowed; pass the program and its arguments directly")

// Run executes name with args directly (never through a shell), with a timeout, and
// returns combined output. It refuses `sh -c ...`, and shells started through common
// wrappers (`env sh -c`, `busybox sh`). This guard is best-effort: other interpreters
// (`python3 -c`, `perl -e`) are not blocked. Never let a caller choose the program,
// and validate every caller-supplied argument with SafeArg and a per-tool allowlist.
func Run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if shells[filepath.Base(name)] {
		for _, a := range args {
			if strings.HasPrefix(a, "-") && strings.Contains(a, "c") {
				return nil, ErrShell
			}
		}
	}
	if wrappers[filepath.Base(name)] {
		for _, a := range args {
			if shells[filepath.Base(a)] {
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
