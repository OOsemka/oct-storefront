// Package kubeclient is a minimal Kubernetes API client for extension backends.
//
// It always verifies the API server certificate against the cluster CA; there is no
// option to skip verification. Calls are made either with the pod's ServiceAccount
// token (re-read on every call, because bound tokens rotate) or with a caller's own
// token, so the API server applies the caller's RBAC.
package kubeclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	saDir        = "/var/run/secrets/kubernetes.io/serviceaccount"
	saTokenFile  = saDir + "/token"
	saCAFile     = saDir + "/ca.crt"
	maxBodyBytes = 4 << 20
)

// Client talks to the Kubernetes API server.
type Client struct {
	host      string
	http      *http.Client
	tokenFile string
}

// StatusError is a non-2xx answer from the API server.
type StatusError struct {
	Code    int
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("kubernetes API returned %d: %s", e.Code, e.Message)
}

// IsStatus reports whether err is a StatusError with the given HTTP code.
func IsStatus(err error, code int) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Code == code
}

// InCluster builds a client from the pod's environment and ServiceAccount mount.
func InCluster() (*Client, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("kubeclient: not running in a cluster (KUBERNETES_SERVICE_HOST/PORT unset)")
	}
	ca, err := os.ReadFile(saCAFile)
	if err != nil {
		return nil, fmt.Errorf("kubeclient: read cluster CA: %w", err)
	}
	return New("https://"+net.JoinHostPort(host, port), ca, saTokenFile)
}

// New builds a client for host, trusting only caPEM. tokenFile holds the
// ServiceAccount token used when a call passes no caller token ("" disables it).
func New(host string, caPEM []byte, tokenFile string) (*Client, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("kubeclient: no certificates in the CA bundle")
	}
	if !strings.HasPrefix(host, "https://") {
		return nil, errors.New("kubeclient: the API server must be reached over https")
	}
	transport := &http.Transport{
		TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		Proxy:               nil, // never send cluster credentials through an HTTP proxy
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	}
	return &Client{
		host:      strings.TrimRight(host, "/"),
		http:      &http.Client{Transport: transport, Timeout: 15 * time.Second},
		tokenFile: tokenFile,
	}, nil
}

func (c *Client) serviceAccountToken() (string, error) {
	if c.tokenFile == "" {
		return "", errors.New("kubeclient: no ServiceAccount token configured")
	}
	b, err := os.ReadFile(c.tokenFile)
	if err != nil {
		return "", fmt.Errorf("kubeclient: read ServiceAccount token: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}

// Do sends one request. With token == "" it uses the ServiceAccount token. body and
// out are JSON (either may be nil).
func (c *Client) Do(ctx context.Context, method, path string, token string, body, out any) error {
	if token == "" {
		t, err := c.serviceAccountToken()
		if err != nil {
			return err
		}
		token = t
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.host+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var st struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &st)
		if st.Message == "" {
			st.Message = http.StatusText(resp.StatusCode)
		}
		return &StatusError{Code: resp.StatusCode, Message: st.Message}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// ResourceAttributes describe one permission check.
type ResourceAttributes struct {
	Namespace   string `json:"namespace,omitempty"`
	Verb        string `json:"verb"`
	Group       string `json:"group,omitempty"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Name        string `json:"name,omitempty"`
}

// SelfSubjectAccessReview asks the API server, as the owner of userToken, whether
// that user may perform ra. The backend's own ServiceAccount needs no extra RBAC.
// An invalid or expired token yields a StatusError with Code 401.
func (c *Client) SelfSubjectAccessReview(ctx context.Context, userToken string, ra ResourceAttributes) (allowed bool, reason string, err error) {
	if userToken == "" {
		return false, "", errors.New("kubeclient: SelfSubjectAccessReview needs the caller's token")
	}
	req := map[string]any{
		"apiVersion": "authorization.k8s.io/v1",
		"kind":       "SelfSubjectAccessReview",
		"spec":       map[string]any{"resourceAttributes": ra},
	}
	var resp struct {
		Status struct {
			Allowed bool   `json:"allowed"`
			Reason  string `json:"reason"`
		} `json:"status"`
	}
	if err := c.Do(ctx, http.MethodPost, "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", userToken, req, &resp); err != nil {
		return false, "", err
	}
	return resp.Status.Allowed, resp.Status.Reason, nil
}

// TokenReview resolves userToken to a username using the ServiceAccount token.
// Optional: the ServiceAccount needs the system:auth-delegator ClusterRole.
func (c *Client) TokenReview(ctx context.Context, userToken string) (username string, authenticated bool, err error) {
	req := map[string]any{
		"apiVersion": "authentication.k8s.io/v1",
		"kind":       "TokenReview",
		"spec":       map[string]any{"token": userToken},
	}
	var resp struct {
		Status struct {
			Authenticated bool `json:"authenticated"`
			User          struct {
				Username string `json:"username"`
			} `json:"user"`
		} `json:"status"`
	}
	if err := c.Do(ctx, http.MethodPost, "/apis/authentication.k8s.io/v1/tokenreviews", "", req, &resp); err != nil {
		return "", false, err
	}
	return resp.Status.User.Username, resp.Status.Authenticated, nil
}

// GetConfigMap returns the data of a ConfigMap, read with the ServiceAccount token.
func (c *Client) GetConfigMap(ctx context.Context, namespace, name string) (map[string]string, error) {
	var cm struct {
		Data map[string]string `json:"data"`
	}
	if err := c.Do(ctx, http.MethodGet, "/api/v1/namespaces/"+namespace+"/configmaps/"+name, "", nil, &cm); err != nil {
		return nil, err
	}
	return cm.Data, nil
}
