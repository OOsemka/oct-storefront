// Package backendsecuritykit is the shared security library for OpenShift Community
// Tools extension backends. Its only dependency is gopkg.in/yaml.v3 (policy parsing).
//
//   - auth: who is calling, and may they do this? Per-route permission table checked
//     with a SelfSubjectAccessReview made with the caller's own token, off/audit/enforce
//     modes, and a runtime override from the cluster policy.
//   - kubeclient: an in-cluster API client that always verifies the cluster CA.
//   - server: TLS-only HTTPS server with timeouts, body limits, no CORS, and a separate
//     plain health port.
//   - validate: names, namespaces, paths and commands from callers.
//
// See README.md for how to adopt it.
package backendsecuritykit
