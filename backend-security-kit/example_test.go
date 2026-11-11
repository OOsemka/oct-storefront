package backendsecuritykit_test

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/auth"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/kubeclient"
	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/server"
)

// A backend adopting the kit: one permission rule per route, next to the handlers.
func Example() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := kubeclient.InCluster()
	if err != nil {
		slog.Error("not in a cluster", "error", err)
		return
	}
	policy := auth.NewPolicySource(client, 0, nil)
	go policy.Run(ctx)

	listHosts := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { /* ... */ })
	serveImage := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { /* ... */ })

	authz, err := auth.New(auth.Options{
		Extension: "oct-example",
		Mode:      auth.ModeFromEnv(), // AUTH_MODE: enforce | audit (default) | off
		Client:    client,
		Policy:    policy,
	}, []auth.Route{
		{Pattern: "GET /api/v1/hosts/{ns}", Handler: listHosts, Checks: []auth.Check{
			{Verb: "list", Group: "metal3.io", Resource: "baremetalhosts", Namespace: auth.PathValue("ns")},
		}},
		// Fetched by Ironic, which has no user token. Keep public routes to a minimum.
		{Pattern: "GET /api/v1/images/{file}", Public: true, Handler: serveImage},
	})
	if err != nil {
		slog.Error("bad permission table", "error", err)
		return
	}

	err = server.Run(ctx, server.Config{
		CertFile: "/var/serving-cert/tls.crt",
		KeyFile:  "/var/serving-cert/tls.key",
		Handler:  authz.Handler(), // one pattern decides both the check and the handler
	})
	if err != nil {
		slog.Error("server stopped", "error", err)
	}
}
