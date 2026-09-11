#!/usr/bin/env bash
# validate-catalog.sh — Pre-ship check for OCT catalog consistency
#
# Verifies:
#   1. Every image tag in community.yaml versions[] exists on the registry
#   2. Every image tag in catalog/deploy/*.yaml exists on the registry
#   3. Both OCP minors (4.21, 4.22) are present for each (tool, semver)
#   4. The 4.21 row points at a -ocp4.21 tag and 4.22 at -ocp4.22
#   5. Deploy YAML image tags match the newest catalog version for that tool
#   6. Every deploy YAML has a matching BUNDLED_DEPLOY entry
#
# Requires: python3, skopeo (optional — pass --skip-registry to skip remote checks)
#
# Usage:
#   ./scripts/validate-catalog.sh              # full check
#   ./scripts/validate-catalog.sh --skip-registry  # offline, structural only

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CATALOG="$REPO_DIR/catalog/community.yaml"
DEPLOY_DIR="$REPO_DIR/catalog/deploy"
ACTIONS_TS="$REPO_DIR/src/utils/catalog-actions.ts"

OCP_MINORS=("4.21" "4.22")
SKIP_REGISTRY=false
ERRORS=0
WARNINGS=0

for arg in "$@"; do
  case "$arg" in
    --skip-registry) SKIP_REGISTRY=true ;;
  esac
done

red()    { printf '\033[0;31mERROR: %s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33mWARN:  %s\033[0m\n' "$1"; }
green()  { printf '\033[0;32mOK:    %s\033[0m\n' "$1"; }
info()   { printf '       %s\n' "$1"; }

error() { red "$1"; ((ERRORS++)); }
warn()  { yellow "$1"; ((WARNINGS++)); }

# ── 1. Parse catalog ────────────────────────────────────────────────

echo "═══ Validating OCT catalog ═══"
echo ""

if [[ ! -f "$CATALOG" ]]; then
  error "catalog/community.yaml not found at $CATALOG"
  exit 1
fi

# Use python3 to parse multi-doc YAML and extract structured data
CATALOG_DATA=$(python3 -c "
import yaml, json, sys
tools = []
with open('$CATALOG') as f:
    for doc in yaml.safe_load_all(f):
        if not doc or 'metadata' not in doc:
            continue
        name = doc['metadata'].get('name', '')
        spec = doc.get('spec', {})
        versions = spec.get('versions', [])
        for v in versions:
            tools.append({
                'tool': name,
                'version': v.get('version', ''),
                'openshift': v.get('openshift', []),
                'image': v.get('image', ''),
                'channel': v.get('channel', 'stable'),
            })
json.dump(tools, sys.stdout)
")

# ── 2. Check OCP minor completeness ─────────────────────────────────

echo "── OCP minor completeness ──"

MINOR_ISSUES=$(python3 -c "
import json, sys
rows = json.loads('''$CATALOG_DATA''')

groups = {}
for r in rows:
    key = (r['tool'], r['version'])
    groups.setdefault(key, []).append(r)

issues = []
for (tool, ver), entries in sorted(groups.items()):
    minors = set()
    for e in entries:
        for m in e['openshift']:
            minors.add(m)

    for expected in ['4.21', '4.22']:
        if expected not in minors:
            issues.append(f'{tool} v{ver} has no openshift {expected} row')

    for e in entries:
        for m in e['openshift']:
            expected_suffix = f'-ocp{m}'
            if e['image'] and not e['image'].endswith(expected_suffix):
                issues.append(f'{tool} v{ver} ocp={m} image={e[\"image\"]} should end with {expected_suffix}')

for i in issues:
    print(i)
")

if [[ -n "$MINOR_ISSUES" ]]; then
  while IFS= read -r msg; do
    error "$msg"
  done <<< "$MINOR_ISSUES"
else
  green "All (tool, version) pairs have both OCP minor rows with correct tag suffixes"
fi

# ── 3. Collect all image references ──────────────────────────────────

echo ""
echo "── Image references ──"

# From catalog versions[]
CATALOG_IMAGES=$(python3 -c "
import json
rows = json.loads('''$CATALOG_DATA''')
for r in rows:
    if r['image']:
        print(r['image'])
" | sort -u)

# From deploy YAMLs
DEPLOY_IMAGES=""
if [[ -d "$DEPLOY_DIR" ]]; then
  DEPLOY_IMAGES=$(grep -rh '^\s*image:' "$DEPLOY_DIR"/*.yaml 2>/dev/null \
    | sed 's/.*image:\s*//' | tr -d '"' | tr -d "'" | sort -u)
fi

ALL_IMAGES=$(echo -e "$CATALOG_IMAGES\n$DEPLOY_IMAGES" | sort -u | grep -v '^$')
IMAGE_COUNT=$(echo "$ALL_IMAGES" | wc -l)
info "Found $IMAGE_COUNT unique image references"

# ── 4. Registry check ────────────────────────────────────────────────

echo ""
echo "── Registry tag existence ──"

if $SKIP_REGISTRY; then
  yellow "Skipping registry checks (--skip-registry)"
else
  if ! command -v skopeo &>/dev/null; then
    warn "skopeo not found — cannot verify tags exist on registry"
  else
    CHECKED=0
    FAILED=0
    while IFS= read -r img; do
      [[ -z "$img" ]] && continue
      if skopeo inspect --raw "docker://$img" &>/dev/null; then
        ((CHECKED++))
      else
        error "Tag does not exist or is not public: $img"
        ((FAILED++))
      fi
    done <<< "$ALL_IMAGES"

    if (( FAILED == 0 )); then
      green "All $CHECKED image tags exist and are public"
    else
      info "$FAILED of $((CHECKED + FAILED)) tags missing"
    fi
  fi
fi

# ── 5. Deploy YAML vs catalog cross-check ────────────────────────────

echo ""
echo "── Deploy YAML consistency ──"

if [[ -d "$DEPLOY_DIR" ]]; then
  for deploy_file in "$DEPLOY_DIR"/oct-*.yaml; do
    [[ ! -f "$deploy_file" ]] && continue
    tool_name=$(basename "$deploy_file" .yaml)

    # Get the newest catalog version's 4.22 image for this tool
    CATALOG_IMAGE=$(python3 -c "
import json
rows = json.loads('''$CATALOG_DATA''')
tool_rows = [r for r in rows if r['tool'] == '$tool_name' and '4.22' in r['openshift']]
if tool_rows:
    from packaging.version import Version
    try:
        tool_rows.sort(key=lambda r: Version(r['version']), reverse=True)
    except Exception:
        tool_rows.sort(key=lambda r: r['version'], reverse=True)
    print(tool_rows[0]['image'])
" 2>/dev/null || echo "")

    # Get the plugin image from the deploy YAML (first image matching the tool name)
    DEPLOY_PLUGIN_IMAGE=$(grep -h '^\s*image:' "$deploy_file" 2>/dev/null \
      | sed 's/.*image:\s*//' | tr -d '"' | tr -d "'" \
      | grep "$tool_name:" | head -1)

    if [[ -n "$CATALOG_IMAGE" && -n "$DEPLOY_PLUGIN_IMAGE" ]]; then
      if [[ "$CATALOG_IMAGE" == "$DEPLOY_PLUGIN_IMAGE" ]]; then
        green "$tool_name: deploy plugin image matches catalog"
      else
        error "$tool_name: deploy=$DEPLOY_PLUGIN_IMAGE vs catalog=$CATALOG_IMAGE"
      fi
    elif [[ -z "$CATALOG_IMAGE" ]]; then
      warn "$tool_name: no catalog entry found (may be storefront-only tile)"
    fi
  done
else
  warn "No catalog/deploy/ directory found"
fi

# ── 6. BUNDLED_DEPLOY coverage ───────────────────────────────────────

echo ""
echo "── BUNDLED_DEPLOY coverage ──"

if [[ ! -f "$ACTIONS_TS" ]]; then
  warn "catalog-actions.ts not found at $ACTIONS_TS — skipping BUNDLED_DEPLOY check"
else
  if [[ -d "$DEPLOY_DIR" ]]; then
    for deploy_file in "$DEPLOY_DIR"/oct-*.yaml; do
      [[ ! -f "$deploy_file" ]] && continue
      tool_name=$(basename "$deploy_file" .yaml)
      if grep -q "'$tool_name'" "$ACTIONS_TS" 2>/dev/null; then
        green "$tool_name: found in BUNDLED_DEPLOY"
      else
        error "$tool_name: deploy YAML exists but NOT in BUNDLED_DEPLOY map"
      fi
    done
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "═══ Summary ═══"
if (( ERRORS > 0 )); then
  red "$ERRORS error(s), $WARNINGS warning(s)"
  exit 1
else
  green "All checks passed ($WARNINGS warning(s))"
  exit 0
fi
