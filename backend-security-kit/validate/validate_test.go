package validate_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/OOsemka/oct-storefront/backend-security-kit/validate"
)

func TestNames(t *testing.T) {
	for _, ok := range []string{"a", "team-a", "x1"} {
		if validate.DNS1123Label(ok) != nil {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "-a", "a-", "A", "a_b", "a.b", strings.Repeat("a", 64), "a;rm -rf /", "../x"} {
		if validate.DNS1123Label(bad) == nil {
			t.Errorf("%q should be invalid", bad)
		}
	}
	if validate.DNS1123Subdomain("a.b-c.d") != nil || validate.DNS1123Subdomain("a..b") == nil {
		t.Error("subdomain checks")
	}
}

func TestNamespace(t *testing.T) {
	for _, p := range []string{"default", "kube-system", "openshift-config", "openshift", "oct-storefront"} {
		if validate.Namespace(p) == nil {
			t.Errorf("%q must be protected", p)
		}
	}
	if validate.Namespace("team-a") != nil {
		t.Error("team-a should be allowed")
	}
	if validate.Namespace("team-a", "sos-*") == nil || validate.Namespace("sos-c1", "sos-*") != nil {
		t.Error("allow-list globs")
	}
}

func TestSafeJoin(t *testing.T) {
	if p, err := validate.SafeJoin("/cache", "img/rhcos.iso"); err != nil || p != "/cache/img/rhcos.iso" {
		t.Fatalf("p=%q err=%v", p, err)
	}
	for _, bad := range []string{"", "/etc/passwd", "../etc/passwd", "a/../../x", "a\x00b", "\\x"} {
		if _, err := validate.SafeJoin("/cache", bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestSafeArg(t *testing.T) {
	if validate.SafeArg("pool1") != nil {
		t.Error("plain arg")
	}
	for _, bad := range []string{"", "-rf", "--config=/x", "a\nb"} {
		if validate.SafeArg(bad) == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestRunRefusesShellC(t *testing.T) {
	for _, args := range [][]string{{"sh", "-c", "id"}, {"/bin/bash", "-lc", "id"}} {
		if _, err := validate.Run(context.Background(), 0, args[0], args[1:]...); !errors.Is(err, validate.ErrShell) {
			t.Errorf("%v: got %v", args, err)
		}
	}
	out, err := validate.Run(context.Background(), 0, "echo", "a; id")
	if err != nil || strings.TrimSpace(string(out)) != "a; id" {
		t.Fatalf("arguments must not be shell-interpreted: %q %v", out, err)
	}
}

func FuzzSafeJoin(f *testing.F) {
	f.Add("a/b")
	f.Add("../x")
	f.Fuzz(func(t *testing.T, rel string) {
		p, err := validate.SafeJoin("/base", rel)
		if err == nil && p != "/base" && !strings.HasPrefix(p, "/base/") {
			t.Fatalf("%q escaped to %q", rel, p)
		}
	})
}

func FuzzDNS1123Label(f *testing.F) {
	f.Add("team-a")
	f.Fuzz(func(t *testing.T, s string) {
		if validate.DNS1123Label(s) == nil && strings.ContainsAny(s, "/.;$ `\\") {
			t.Fatalf("accepted %q", s)
		}
	})
}
