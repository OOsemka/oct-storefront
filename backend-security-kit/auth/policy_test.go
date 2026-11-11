package auth_test

import (
	"reflect"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
)

func TestParseBackendOverrides(t *testing.T) {
	cases := map[string]map[string]auth.Mode{
		"":                           {},
		"mode: warn\nbackends: {}\n": {},
		"backends:\n  oct-a:\n    authMode: audit\n  oct-b:\n    authMode: \"enforce\"\nperTool: {}\n":    {"oct-a": auth.Audit, "oct-b": auth.Enforce},
		"backends:\n  oct-a: { authMode: audit }  # temporary\n":                                          {"oct-a": auth.Audit},
		"backends: { oct-a: { authMode: audit }, oct-b: { authMode: enforce } }\n":                        {"oct-a": auth.Audit, "oct-b": auth.Enforce},
		"backends:\n  oct-a:\n    authMode: off\n":                                                        {},
		"backends: {}\n#   oct-a:\n#     authMode: audit\n":                                               {},
		"telemetry: full\nbackends:\n    oct-a:\n        other: 1\n        authMode: audit\nmode: warn\n": {"oct-a": auth.Audit},
		// Invalid YAML (bad indentation) gives no overrides, as in the storefront.
		"backends:\n  oct-a:\n    authMode: audit\nmode: warn\n  oct-z:\n    authMode: audit\n": {},
		// Review findings: real YAML forms the old line parser missed or misread.
		"\"backends\":\n  oct-a:\n    authMode: enforce\n":          {"oct-a": auth.Enforce},
		"backends :\n  oct-a:\n    authMode: enforce\n":             {"oct-a": auth.Enforce},
		"\ufeffbackends:\n  oct-a:\n    authMode: enforce\n":        {"oct-a": auth.Enforce},
		"backends:\n  oct-a:\n    authMode: !!str enforce\n":        {"oct-a": auth.Enforce},
		"backends:\n  oct-a: {x: {y: 1}, authMode: enforce}\n":      {"oct-a": auth.Enforce},
		"backends:\n  oct-a:\n    notes:\n      authMode: audit\n":  {},
		"nested:\n  backends:\n    oct-a:\n      authMode: audit\n": {},
	}
	for in, want := range cases {
		if got := auth.ParseBackendOverrides(in); !reflect.DeepEqual(got, want) {
			t.Errorf("input:\n%s\ngot %v want %v", in, got, want)
		}
	}
}

// The shipped example policy (oct-storefront deploy/policy) has only commented overrides.
func TestParseShippedExampleShape(t *testing.T) {
	in := "mode: warn\nbackends: {}\n#   oct-baremetal:\n#     authMode: audit\nperTool: {}\n"
	if got := auth.ParseBackendOverrides(in); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func FuzzParseBackendOverrides(f *testing.F) {
	f.Add("backends:\n  oct-a:\n    authMode: audit\n")
	f.Add("backends: { a: { authMode: enforce } }")
	f.Add("backends: {a:{")
	f.Fuzz(func(t *testing.T, s string) {
		for _, m := range auth.ParseBackendOverrides(s) {
			if m != auth.Audit && m != auth.Enforce {
				t.Fatalf("invalid mode %q", m)
			}
		}
	})
}
