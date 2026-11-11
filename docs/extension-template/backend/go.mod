module github.com/example/oct-example-tool/backend

go 1.22

require github.com/openshift-community-tools/oct-storefront/backend-security-kit v0.1.0

require gopkg.in/yaml.v3 v3.0.1 // indirect

// Template only: builds against the kit in this repository. Delete this line in
// your extension so the pinned version above is used.
replace github.com/openshift-community-tools/oct-storefront/backend-security-kit => ../../../backend-security-kit
