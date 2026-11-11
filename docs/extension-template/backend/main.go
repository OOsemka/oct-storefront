// Backend starter for an OCT extension. Every route is checked with the caller's
// own permissions (backend-security-kit); see the kit README for details.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/server"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/validate"
)

const extension = "oct-example-tool"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := kubeclient.InCluster()
	if err != nil {
		log.Error("startup", "error", err)
		os.Exit(1)
	}
	policy := auth.NewPolicySource(client, 0, log)
	go policy.Run(ctx)

	listPolicies := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.PathValue("ns")
		if err := validate.Namespace(ns); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Read as the caller, so the API server applies the caller's RBAC too. Without a
		// user token (possible in audit mode) refuse, never fall back to the ServiceAccount.
		token := auth.UserToken(r.Context())
		if token == "" {
			http.Error(w, "no user token", http.StatusUnauthorized)
			return
		}
		var out json.RawMessage
		path := "/apis/nmstate.io/v1/namespaces/" + ns + "/nodenetworkconfigurationpolicies"
		if err := client.DoAsUser(r.Context(), http.MethodGet, path, token, nil, &out); err != nil {
			http.Error(w, "could not list policies", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})

	// One entry per route: what the caller must be allowed to do, in RBAC terms, and the
	// handler that runs after the check. One pattern drives both, so the table can't
	// drift from the routes.
	authz, err := auth.New(auth.Options{
		Extension: extension,
		Mode:      auth.ModeFromEnv(), // set AUTH_MODE=enforce in the Deployment (unset means audit)
		Client:    client,
		Policy:    policy,
		Logger:    log,
	}, []auth.Route{
		{Pattern: "GET /api/v1/policies/{ns}", Handler: listPolicies, Checks: []auth.Check{
			{Verb: "list", Group: "nmstate.io", Resource: "nodenetworkconfigurationpolicies", Namespace: auth.PathValue("ns")},
		}},
	})
	if err != nil {
		log.Error("permission table", "error", err)
		os.Exit(1)
	}

	if err := server.Run(ctx, server.Config{
		CertFile: "/var/serving-cert/tls.crt",
		KeyFile:  "/var/serving-cert/tls.key",
		Handler:  authz.Handler(),
		Logger:   log,
	}); err != nil {
		log.Error("server", "error", err)
		os.Exit(1)
	}
}
