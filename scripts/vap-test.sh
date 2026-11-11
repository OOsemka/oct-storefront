#!/bin/bash
# End-to-end tests for the admission policy pack (deploy/policy/vap) against a real
# cluster, as a cluster admin. TEST CLUSTERS ONLY: it switches the pack between warn
# and enforce, deletes and recreates oct-storefront/oct-admission-params, and creates
# scratch namespaces oct-vaptest and vaptest-other. The pack mode and the settings
# ConfigMap found at the start are restored at the end (also on failure or Ctrl-C).
# Objects under test are server-side dry runs, made with impersonated ServiceAccounts.
#
# Usage: scripts/vap-test.sh --test-cluster
set -u
if [ "${1:-}" != "--test-cluster" ]; then
  echo "This changes the admission pack and its settings on the cluster in your kubeconfig ($(oc whoami --show-server 2>/dev/null))." >&2
  echo "Run it on a test cluster only: $0 --test-cluster" >&2
  exit 2
fi
REPO=$(cd "$(dirname "$0")/.." && pwd)
VAP=$REPO/deploy/policy/vap
SA="--as=system:serviceaccount:oct-vaptest:tester"
OTHER="--as=system:serviceaccount:vaptest-other:s"
T=$(mktemp -d)
pass=0; fail=0

# Remember what to put back: the settings ConfigMap and the pack's mode.
oc -n oct-storefront get cm oct-admission-params -o yaml > "$T/params.orig.yaml" 2>/dev/null || rm -f "$T/params.orig.yaml"
ORIG_MODE=$(oc get validatingadmissionpolicybinding oct-no-broad-role-bindings -o jsonpath='{.spec.validationActions}' 2>/dev/null)
restore() {
  echo "== restoring the pack mode and settings found at the start"
  oc -n oct-storefront delete cm oct-admission-params --ignore-not-found >/dev/null
  if [ -f "$T/params.orig.yaml" ]; then
    python3 - "$T/params.orig.yaml" <<'PY' | oc create -f - >/dev/null
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
for k in ("resourceVersion", "uid", "creationTimestamp", "managedFields"):
    d["metadata"].pop(k, None)
print(yaml.safe_dump(d))
PY
  fi
  case "$ORIG_MODE" in
    *Deny*) oc apply -k "$VAP/enforce" >/dev/null ;;
    "")     oc delete -k "$VAP" --ignore-not-found >/dev/null ;;
    *)      oc apply -k "$VAP" >/dev/null ;;
  esac
  oc delete ns oct-vaptest vaptest-other --ignore-not-found --wait=false >/dev/null
  rm -rf "$T"
}
trap restore EXIT
# A previous run's scratch namespaces must be gone first (creates in a terminating
# namespace fail and every case would report an error).
oc wait --for=delete ns/oct-vaptest ns/vaptest-other --timeout=300s >/dev/null 2>&1

# expect <warn|deny|clean> <description> <command...>
expect() {
  local want=$1 desc=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  local got=clean
  # "deny" only counts when one of OUR policies denied it; any other failure is an error.
  if [ $rc -ne 0 ]; then
    if grep -q "ValidatingAdmissionPolicy 'oct-" <<<"$out"; then got=deny; else got=error; fi
  elif grep -q "^Warning: Validation failed" <<<"$out"; then got=warn; fi
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "PASS  $desc"
  else fail=$((fail+1)); echo "FAIL  $desc (want $want, got $got)"; sed 's/^/        /' <<<"$out"; fi
}
params() { oc -n oct-storefront patch cm oct-admission-params --type merge -p "$1" >/dev/null; sleep 3; }
reset_params() { oc -n oct-storefront delete cm oct-admission-params --ignore-not-found >/dev/null; oc create -f "$VAP/params.yaml" >/dev/null; sleep 3; }

cat > "$T/route.yaml" <<'EOF'
apiVersion: route.openshift.io/v1
kind: Route
metadata: {name: test-route, namespace: NS}
spec: {to: {kind: Service, name: nothing}}
EOF
cat > "$T/deploy.yaml" <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: test-deploy, namespace: NS}
spec:
  selector: {matchLabels: {app: t}}
  template:
    metadata: {labels: {app: t}}
    spec: {containers: [{name: c, image: IMAGE, command: [sleep, "3600"]}]}
EOF
cat > "$T/scc.yaml" <<'EOF'
apiVersion: security.openshift.io/v1
kind: SecurityContextConstraints
metadata: {name: oct-vaptest-scc, labels: {communitytools.io/extension: oct-vaptest}}
runAsUser: {type: MustRunAsRange}
seLinuxContext: {type: MustRunAs}
EOF
route() { sed "s/NS/$1/" "$T/route.yaml"; }
deploy() { sed "s/NS/$1/; s#IMAGE#$2#" "$T/deploy.yaml"; }
create() { oc "$@" create -f - --dry-run=server; }   # reads stdin

echo "== setup"
for ns in oct-vaptest vaptest-other; do oc create ns $ns >/dev/null 2>&1; done
oc -n oct-vaptest create sa tester >/dev/null 2>&1
oc -n oct-vaptest create rolebinding tester-admin --clusterrole=admin --serviceaccount=oct-vaptest:tester >/dev/null 2>&1
oc -n vaptest-other create sa s >/dev/null 2>&1
oc -n vaptest-other create rolebinding s-admin --clusterrole=admin --serviceaccount=vaptest-other:s >/dev/null 2>&1
reset_params
oc apply -k "$VAP" >/dev/null && sleep 5

echo "== warn mode, default settings"
expect warn  "SA in oct-* binds edit"                 oc $SA -n oct-vaptest create rolebinding x --clusterrole=edit --serviceaccount=oct-vaptest:tester --dry-run=server
expect clean "SA in oct-* binds view"                 oc $SA -n oct-vaptest create rolebinding x --clusterrole=view --serviceaccount=oct-vaptest:tester --dry-run=server
expect warn  "labelled binding to admin (by admin)"   sh -c 'oc -n default create rolebinding y --clusterrole=admin --user=nobody --dry-run=client -o yaml | oc label -f - --local communitytools.io/extension=oct-labeltest -o yaml | oc create -f - --dry-run=server'
expect clean "unlabelled cluster-admin binding (not OCT)" oc create clusterrolebinding z --clusterrole=cluster-admin --user=nobody --dry-run=server
expect warn  "SA in oct-* creates Route (unapproved)" sh -c "$(declare -f route); T=$T; route oct-vaptest | oc $SA create -f - --dry-run=server"
expect clean "SA outside oct-* creates Route"         sh -c "$(declare -f route); T=$T; route vaptest-other | oc $OTHER create -f - --dry-run=server"
expect clean "OCT deployment, no registry list"       sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.access.redhat.com/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
expect warn  "labelled SCC (unapproved)"              oc create -f "$T/scc.yaml" --dry-run=server

echo "== warn mode, settings"
params '{"data":{"approvedRoutes":"oct-baremetal, oct-vaptest","allowedRegistries":"quay.io/openshift-community-tools,registry.redhat.io","approvedSCCs":"oct-vaptest"}}'
expect clean "Route after approval"                   sh -c "$(declare -f route); T=$T; route oct-vaptest | oc $SA create -f - --dry-run=server"
expect clean "SCC after approval"                     oc create -f "$T/scc.yaml" --dry-run=server
expect warn  "image outside allowedRegistries"        sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.access.redhat.com/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
expect warn  "look-alike registry prefix"             sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.redhat.io.evil.example/x:1 | oc $SA create -f - --dry-run=server"
expect clean "image in allowed registry"              sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.redhat.io/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
params '{"data":{"requireDigest":"true"}}'
expect warn  "tag instead of digest"                  sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.redhat.io/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
expect warn  "bare Pod with tag"                      oc $SA -n oct-vaptest run p --image=registry.redhat.io/ubi9/ubi-minimal:latest --restart=Never --dry-run=server
expect clean "digest-pinned image"                    sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.redhat.io/ubi9/ubi-minimal@sha256:0000000000000000000000000000000000000000000000000000000000000000 | oc $SA create -f - --dry-run=server"

echo "== enforce mode (settings must survive the switch)"
oc apply -k "$VAP/enforce" >/dev/null && sleep 5
expect deny  "SA in oct-* binds edit"                 oc $SA -n oct-vaptest create rolebinding x --clusterrole=edit --serviceaccount=oct-vaptest:tester --dry-run=server
expect deny  "tag instead of digest (settings kept)"  sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.redhat.io/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
params '{"data":{"approvedRoutes":""}}'
expect deny  "Route unapproved"                       sh -c "$(declare -f route); T=$T; route oct-vaptest | oc $SA create -f - --dry-run=server"
expect clean "unlabelled cluster-admin binding (not OCT)" oc create clusterrolebinding z --clusterrole=cluster-admin --user=nobody --dry-run=server
expect clean "SA outside oct-* creates Route"         sh -c "$(declare -f route); T=$T; route vaptest-other | oc $OTHER create -f - --dry-run=server"
expect clean "non-OCT deployment with tag"            sh -c "$(declare -f deploy); T=$T; deploy vaptest-other registry.access.redhat.com/ubi9/ubi-minimal:latest | oc $OTHER create -f - --dry-run=server"

echo "== enforce mode, settings ConfigMap missing (must fail open, never block the cluster)"
oc -n oct-storefront delete cm oct-admission-params >/dev/null; sleep 3
expect clean "non-OCT deployment"                     sh -c "$(declare -f deploy); T=$T; deploy vaptest-other registry.access.redhat.com/ubi9/ubi-minimal:latest | oc $OTHER create -f - --dry-run=server"
expect clean "OCT deployment (image rules skipped)"   sh -c "$(declare -f deploy); T=$T; deploy oct-vaptest registry.access.redhat.com/ubi9/ubi-minimal:latest | oc $SA create -f - --dry-run=server"
expect deny  "SA in oct-* binds edit (needs no settings)" oc $SA -n oct-vaptest create rolebinding x --clusterrole=edit --serviceaccount=oct-vaptest:tester --dry-run=server

echo "== review fixes (2026-11-10), enforce mode"
reset_params; oc apply -k "$VAP/enforce" >/dev/null; sleep 5
# C4: an extension SA must not touch the security configuration (give it RBAC first).
oc -n oct-storefront create role vaptest-cm --verb=get,update,patch,delete --resource=configmaps >/dev/null 2>&1
oc -n oct-storefront create rolebinding vaptest-cm --role=vaptest-cm --serviceaccount=oct-vaptest:tester >/dev/null 2>&1
expect deny  "C4 SA deletes oct-admission-params"     oc $SA -n oct-storefront delete cm oct-admission-params --dry-run=server
expect deny  "C4 SA edits oct-admission-params"       oc $SA -n oct-storefront patch cm oct-admission-params --type merge -p '{"data":{"approvedRoutes":"*"}}' --dry-run=server
expect clean "C4 admin edits oct-admission-params"    oc -n oct-storefront patch cm oct-admission-params --type merge -p '{"data":{"approvedRoutes":""}}' --dry-run=server
oc -n oct-storefront delete rolebinding vaptest-cm >/dev/null; oc -n oct-storefront delete role vaptest-cm >/dev/null
# C5: a label must not borrow another extension's approval.
params '{"data":{"approvedRoutes":"oct-baremetal"}}'
expect deny  "C5 SA labels its Route oct-baremetal"   sh -c "$(declare -f route); T=$T; route oct-vaptest | oc label -f - --local communitytools.io/extension=oct-baremetal -o yaml | oc $SA create -f - --dry-run=server"
# C6: Ingress, SCC role binding, ephemeral container.
expect deny  "C6 SA creates an Ingress (unapproved)"  sh -c "printf 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: {name: i, namespace: oct-vaptest}\nspec: {defaultBackend: {service: {name: x, port: {number: 80}}}}\n' | oc $SA create -f - --dry-run=server"
oc -n oct-vaptest create rolebinding tester-scc-admin --clusterrole=cluster-admin --serviceaccount=oct-vaptest:tester >/dev/null 2>&1
expect deny  "C6 SA binds system:openshift:scc:anyuid" oc $SA -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:anyuid --serviceaccount=oct-vaptest:tester --dry-run=server
# C10 (2026-11-11 review): SCC role bindings need approvedSCCBindings; "ext:scc" approves one SCC only.
params '{"data":{"approvedSCCBindings":"oct-vaptest:anyuid"}}'
expect clean "C10 anyuid binding after scoped approval" oc $SA -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:anyuid --serviceaccount=oct-vaptest:tester --dry-run=server
expect deny  "C10 scoped approval doesn't cover privileged" oc $SA -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:privileged --serviceaccount=oct-vaptest:tester --dry-run=server
params '{"data":{"approvedSCCBindings":"oct-shift-on-shift-virt:anyuid"}}'
expect deny  "C10 another extension's approval doesn't count" sh -c "oc -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:anyuid --serviceaccount=oct-vaptest:tester --dry-run=client -o yaml | oc label -f - --local communitytools.io/extension=oct-shift-on-shift-virt -o yaml | oc $SA create -f - --dry-run=server"
params '{"data":{"approvedSCCBindings":"oct-vaptest"}}'
expect clean "C10 unscoped approval covers privileged" oc $SA -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:privileged --serviceaccount=oct-vaptest:tester --dry-run=server
expect deny  "C10 approval never covers edit"        oc $SA -n oct-vaptest create rolebinding x --clusterrole=edit --serviceaccount=oct-vaptest:tester --dry-run=server
oc -n oct-storefront delete cm oct-admission-params >/dev/null; sleep 3
expect clean "C10 settings missing: SCC binding rule skipped" oc $SA -n oct-vaptest create rolebinding scc --clusterrole=system:openshift:scc:anyuid --serviceaccount=oct-vaptest:tester --dry-run=server
expect deny  "C10 settings missing: edit still refused" oc $SA -n oct-vaptest create rolebinding x --clusterrole=edit --serviceaccount=oct-vaptest:tester --dry-run=server
reset_params
oc -n oct-vaptest delete rolebinding tester-scc-admin >/dev/null
params '{"data":{"allowedRegistries":"registry.redhat.io"}}'
# As cluster-admin on a labelled pod: SCC admission rejects the patch for the test SA
# before the policy is reached, which says nothing about the policy.
oc -n oct-vaptest run eph --image=registry.redhat.io/ubi9/ubi-minimal:latest --restart=Never --labels=communitytools.io/extension=oct-vaptest --command -- sleep 3600 >/dev/null 2>&1; sleep 2
expect deny  "C6 ephemeral container from another registry" oc -n oct-vaptest patch pod eph --subresource=ephemeralcontainers --type=strategic -p '{"spec":{"ephemeralContainers":[{"name":"dbg","image":"quay.io/evil/x:1","command":["true"]}]}}' --dry-run=server
# C9: under enforce, updates that don't change images are not re-checked.
params '{"data":{"allowedRegistries":"registry.redhat.io"}}'
oc apply -k "$VAP" >/dev/null; sleep 4
deploy oct-vaptest quay.io/openshift-community-tools/oct-hello-world:1.0.0-ocp4.22 | oc label -f - --local communitytools.io/extension=oct-vaptest -o yaml | oc create -f - >/dev/null 2>&1
oc apply -k "$VAP/enforce" >/dev/null; sleep 4
expect clean "C9 scale a labelled Deployment (image unchanged)" oc -n oct-vaptest scale deploy/test-deploy --replicas=0 --dry-run=server
expect clean "C9 relabel it (image unchanged)"        oc -n oct-vaptest label deploy/test-deploy extra=1 --dry-run=server
expect deny  "C9 change its image to another registry" oc -n oct-vaptest set image deploy/test-deploy c=quay.io/evil/x:2 --dry-run=server
reset_params

echo "== $pass passed, $fail failed"
[ $fail -eq 0 ]
