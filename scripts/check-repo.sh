#!/usr/bin/env bash
# Repository rules that the build does not catch. Run: yarn check-repo
#  - PatternFly 6 only: no PatternFly CSS imports (the console provides the styles).
#  - Nothing private in tracked files: home directory paths, OpenShift tokens,
#    JWTs or private keys.
#  - Security patterns (docs/security-model.md in oct-storefront). Warnings by
#    default; CHECK_REPO_SECURITY=error makes them fail.
set -euo pipefail
fail=0
security_mode="${CHECK_REPO_SECURITY:-warn}"

report() {
  echo "check-repo: $1"
  echo "$2" | sed 's/^/  /'
  fail=1
}

pf_css=$(git grep -nE "@patternfly/(patternfly|react-[a-z]+/dist/styles)|patternfly[^'\"]*\.css" -- 'src/*' || true)
[ -n "$pf_css" ] && report "PatternFly CSS imports are not allowed (the console loads PatternFly 6):" "$pf_css"

private=$(git grep -nIE "(/home/[a-z][a-z0-9_-]+/|/Users/[A-Za-z][A-Za-z0-9_-]+/|sha256~[A-Za-z0-9_-]{20,}|eyJhbGciOi[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY)" -- . ':!scripts/check-repo.sh' ':!yarn.lock' ':!.yarn/*' || true)
[ -n "$private" ] && report "private data (home paths, tokens or keys) in tracked files:" "$private"

# --- Security patterns -------------------------------------------------------
# Markdown, Cursor rules, tests and this script are excluded (they describe the patterns). Local
# dev servers (webpack.config.js) may use CORS *: the console on :9000 loads the
# plugin from :9001. What ships (nginx.conf, Go servers) must not.
security_warn() {
  if [ "$security_mode" = "error" ]; then
    report "security: $1" "$2"
  else
    echo "check-repo: security warning: $1"
    echo "$2" | head -5 | sed 's/^/  /'
    local n
    n=$(echo "$2" | wc -l)
    [ "$n" -gt 5 ] && echo "  ... and $((n - 5)) more"
  fi
  return 0
}
sec() { git grep -nIE "$1" -- "${@:2}" ':!*.md' ':!*.mdc' ':!scripts/check-repo.sh' ':!yarn.lock' ':!.yarn/*' ':!*_test.go' ':!*/__tests__/*' || true; }
Q="[\"']"   # either quote character
SH='"(/bin/)?(ba|z|da|k)?sh"'

hit=$(sec 'Access-Control-Allow-(Origin|Headers|Methods).*\*' . ':!webpack.config.js')
[ -n "$hit" ] && security_warn "CORS wildcard in shipped config or code (the console proxy needs no CORS):" "$hit"
hit=$(sec 'InsecureSkipVerify:[[:space:]]*true|insecure-skip-tls-verify:[[:space:]]*true|rejectUnauthorized:[[:space:]]*false' .)
[ -n "$hit" ] && security_warn "TLS verification turned off (use the cluster CA; see backend-security-kit/kubeclient):" "$hit"
hit=$(sec 'chmod[[:space:]]+(-R[[:space:]]+)?0?777' .)
[ -n "$hit" ] && security_warn "chmod 777 (use chgrp 0 + chmod g=u for OpenShift's random UID):" "$hit"
hit=$(sec 'exec\.Command(Context)?\((ctx,[[:space:]]*)?'"$SH"',[[:space:]]*"-[a-z]*c"' '*.go')
[ -n "$hit" ] && security_warn "shell command lines in Go (pass the program and arguments directly; see validate.Run):" "$hit"
hit=$(sec 'image:[[:space:]]*'"$Q"'?[^[:space:]#]+:latest'"($Q|[[:space:]]|\$)" '*.yaml' '*.yml')
[ -n "$hit" ] && security_warn ":latest images (use a version tag, ideally pinned by digest):" "$hit"
hit=$(sec 'deployU[Rr][Ll]:[[:space:]]*'"$Q"'?https://raw\.githubusercontent\.com/[^/]+/[^/]+/(main|master)/' '*.yaml' '*.yml')
[ -n "$hit" ] && security_warn "deployURL on a moving branch (point at a release tag so a reviewed manifest can't change):" "$hit"
hit=$(sec '^[[:space:]]*-[[:space:]]*'"$Q"'\*'"$Q"'[[:space:]]*$|(verbs|resources|apiGroups):[[:space:]]*\[[[:space:]]*'"$Q"'?\*' 'deploy/*.yaml' 'catalog/deploy/*.yaml' '*manifests/*.yaml')
[ -n "$hit" ] && security_warn "RBAC wildcards (list the verbs and resources the tool needs):" "$hit"
hit=$(sec '[Kk]ind'"$Q"'?:[[:space:]]*'"$Q"'SecurityContextConstraints'"$Q" 'src/*' '*.go')
[ -n "$hit" ] && security_warn "code creates an SCC at runtime (declare it in spec.security.privileged.runtimeCreates, with cleanup):" "$hit"

[ "$fail" -eq 0 ] && echo "check-repo: ok"
exit "$fail"
