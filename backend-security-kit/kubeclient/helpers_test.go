package kubeclient_test

import (
	"encoding/pem"
	"testing"

	"github.com/openshift-community-tools/oct-storefront/backend-security-kit/internal/fakeapi"
)

func pemOf(t *testing.T, s *fakeapi.Server) []byte {
	t.Helper()
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw})
}
