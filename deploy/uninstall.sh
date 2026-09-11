#!/bin/bash
# OCT Uninstall — Remove all OpenShift Community Tools from the cluster
#
# Usage:
#   oc login ...
#   bash <(curl -s https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/uninstall.sh)
#
# Or locally:
#   ./deploy/uninstall.sh
#
# This script removes:
#   - All oct-* ConsolePlugins and their entries from console spec.plugins
#   - All oct-* namespaces (including Deployments, Services, PVCs, ConfigMaps)
#   - OCT ClusterRoles and ClusterRoleBindings
#
# System plugins (monitoring, kubevirt, networking, forklift, etc.) are NOT touched.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== OCT Uninstall ===${NC}"
echo ""

# Check oc is logged in
if ! oc whoami &>/dev/null; then
  echo -e "${RED}Error: Not logged in to OpenShift. Run 'oc login' first.${NC}"
  exit 1
fi

echo -e "Cluster: $(oc whoami --show-server)"
echo -e "User: $(oc whoami)"
echo ""

# 1. Find all OCT ConsolePlugins
echo -e "${YELLOW}Step 1: Finding OCT ConsolePlugins...${NC}"
OCT_PLUGINS=$(oc get consoleplugin -o name 2>/dev/null | grep -E '(oct-|openshift-baremetal-dashboard|community-)' || true)

if [ -z "$OCT_PLUGINS" ]; then
  echo "  No OCT ConsolePlugins found."
else
  echo "  Found:"
  echo "$OCT_PLUGINS" | sed 's/^/    /'
fi

# 2. Remove OCT plugins from Console spec.plugins
echo ""
echo -e "${YELLOW}Step 2: Removing OCT entries from Console spec.plugins...${NC}"
CURRENT_PLUGINS=$(oc get console.operator.openshift.io cluster -o jsonpath='{.spec.plugins}' 2>/dev/null || echo "[]")
# Build a list of OCT plugin names to remove
OCT_NAMES=$(echo "$OCT_PLUGINS" | sed 's|consoleplugin.console.openshift.io/||' || true)

if [ -n "$OCT_NAMES" ]; then
  # Use python3 to filter out OCT plugins
  NEW_PLUGINS=$(echo "$CURRENT_PLUGINS" | python3 -c "
import sys, json
plugins = json.loads(sys.stdin.read())
oct_prefixes = ('oct-', 'openshift-baremetal-dashboard', 'community-')
filtered = [p for p in plugins if not any(p.startswith(prefix) for prefix in oct_prefixes)]
print(json.dumps(filtered))
" 2>/dev/null || echo "$CURRENT_PLUGINS")

  oc patch console.operator.openshift.io cluster --type=merge -p "{\"spec\":{\"plugins\":$NEW_PLUGINS}}" 2>/dev/null && \
    echo -e "  ${GREEN}Patched spec.plugins${NC}" || \
    echo -e "  ${YELLOW}Warning: Could not patch spec.plugins${NC}"
else
  echo "  No OCT plugins to remove from spec.plugins."
fi

# 3. Delete OCT ConsolePlugins
echo ""
echo -e "${YELLOW}Step 3: Deleting OCT ConsolePlugins...${NC}"
if [ -n "$OCT_PLUGINS" ]; then
  for plugin in $OCT_PLUGINS; do
    oc delete "$plugin" --ignore-not-found 2>/dev/null && \
      echo -e "  ${GREEN}Deleted $plugin${NC}" || \
      echo -e "  ${YELLOW}Warning: Could not delete $plugin${NC}"
  done
else
  echo "  Nothing to delete."
fi

# 4. Find and delete OCT namespaces
echo ""
echo -e "${YELLOW}Step 4: Deleting OCT namespaces...${NC}"
OCT_NS=$(oc get namespaces -o name 2>/dev/null | grep -E '(oct-|openshift-baremetal-dashboard|community-network-bond)' || true)

if [ -z "$OCT_NS" ]; then
  echo "  No OCT namespaces found."
else
  for ns in $OCT_NS; do
    oc delete "$ns" --ignore-not-found 2>/dev/null && \
      echo -e "  ${GREEN}Deleted $ns${NC}" || \
      echo -e "  ${YELLOW}Warning: Could not delete $ns (may take a moment)${NC}"
  done
fi

# 5. Clean up ClusterRoles and ClusterRoleBindings
echo ""
echo -e "${YELLOW}Step 5: Cleaning up ClusterRoles and ClusterRoleBindings...${NC}"
for resource in clusterrole clusterrolebinding; do
  ITEMS=$(oc get "$resource" -o name 2>/dev/null | grep -E '(oct-|openshift-baremetal-dashboard|community-)' || true)
  if [ -n "$ITEMS" ]; then
    for item in $ITEMS; do
      oc delete "$item" --ignore-not-found 2>/dev/null && \
        echo -e "  ${GREEN}Deleted $item${NC}" || \
        echo -e "  ${YELLOW}Warning: Could not delete $item${NC}"
    done
  fi
done

# 6. Verify
echo ""
echo -e "${YELLOW}Step 6: Verifying clean state...${NC}"
REMAINING_NS=$(oc get namespaces -o name 2>/dev/null | grep -E '(oct-|openshift-baremetal-dashboard|community-)' || true)
REMAINING_CP=$(oc get consoleplugin -o name 2>/dev/null | grep -E '(oct-|openshift-baremetal-dashboard|community-)' || true)

if [ -z "$REMAINING_NS" ] && [ -z "$REMAINING_CP" ]; then
  echo -e "  ${GREEN}All OCT resources removed successfully.${NC}"
else
  if [ -n "$REMAINING_NS" ]; then
    echo -e "  ${YELLOW}Remaining namespaces (may still be terminating):${NC}"
    echo "$REMAINING_NS" | sed 's/^/    /'
  fi
  if [ -n "$REMAINING_CP" ]; then
    echo -e "  ${YELLOW}Remaining ConsolePlugins:${NC}"
    echo "$REMAINING_CP" | sed 's/^/    /'
  fi
fi

echo ""
echo -e "${GREEN}=== OCT Uninstall Complete ===${NC}"
echo "You can reinstall OCT with:"
echo "  oc apply -f https://raw.githubusercontent.com/OOsemka/oct-storefront/main/deploy/install.yaml"
