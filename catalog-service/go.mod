module github.com/cjanisze/oct-storefront/catalog-service

go 1.22

require (
	github.com/openshift-community-tools/oct-storefront/backend-security-kit v0.2.0-dev.3
	gopkg.in/yaml.v3 v3.0.1
)

// Until backend-security-kit is released, build against the security-framework fork's
// dev tag (the Containerfile builds catalog-service/ on its own, so a local path
// replacement wouldn't be visible). Remove this line once the release is tagged.
replace github.com/openshift-community-tools/oct-storefront/backend-security-kit => github.com/dsorrentino/oct-storefront/backend-security-kit v0.2.0-dev.3
