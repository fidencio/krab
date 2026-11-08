#!/usr/bin/env bash
# Exercise the report collector with the same tools shipped in its image.
set -euo pipefail
command -v bash >/dev/null
command -v curl >/dev/null
command -v jq >/dev/null

collector=${1:?collector script path is required}
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin" "$fixture_dir/serviceaccount"
printf '%s' test-token > "$fixture_dir/serviceaccount/token"
: > "$fixture_dir/serviceaccount/ca.crt"
cat > "$fixture_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
url=''
for arg in "$@"; do
  [[ $arg != https://* ]] || url=$arg
done
case "$url" in
  */api/v1/nodes)
    [[ " $* " == *" labelSelector=$NODE_SELECTOR "* ]] || exit 1
    if [[ $SCENARIO == empty ]]; then
      echo '{"items":[]}'
    elif [[ $SCENARIO == missing ]]; then
      echo '{"items":[{"metadata":{"name":"node-1","uid":"uid-1"},"status":{"nodeInfo":{"machineID":"machine-1","bootID":"boot-1"}}},{"metadata":{"name":"node-2","uid":"uid-2"},"status":{"nodeInfo":{"machineID":"machine-2","bootID":"boot-2"}}}]}'
    else
      if [[ $SCENARIO == changed && -f $SERVICE_ACCOUNT_DIR/listed ]]; then
        echo '{"items":[{"metadata":{"name":"node-1","uid":"uid-1"},"status":{"nodeInfo":{"machineID":"machine-1","bootID":"boot-2"}}}]}'
      else
        echo '{"items":[{"metadata":{"name":"node-1","uid":"uid-1"},"status":{"nodeInfo":{"machineID":"machine-1","bootID":"boot-1"}}}]}'
      fi
      [[ $SCENARIO != changed ]] || touch "$SERVICE_ACCOUNT_DIR/listed"
    fi ;;
  */jobs/krab-precheck-dispatcher)
    if [[ $SCENARIO == dispatcher_failed ]]; then
      echo '{"metadata":{"uid":"current-dispatcher"},"status":{"conditions":[{"type":"Failed","status":"True"}]}}'
    else
      echo '{"metadata":{"uid":"current-dispatcher"},"status":{"conditions":[{"type":"Complete","status":"True"}]}}'
    fi ;;
  */jobs)
    succeeded=1
    [[ $SCENARIO != failed ]] || succeeded=0
    printf '{"items":[{"metadata":{"name":"node-job","ownerReferences":[{"uid":"current-dispatcher"}]},"spec":{"template":{"spec":{"nodeName":"node-1"}}},"status":{"succeeded":%s}},{"metadata":{"name":"old-job","ownerReferences":[{"uid":"old-dispatcher"}]}}]}\n' "$succeeded" ;;
  */pods)
    if [[ $SCENARIO == duplicate ]]; then
      echo '{"items":[{"metadata":{"name":"pod-1"}},{"metadata":{"name":"pod-2"}}]}'
    else
      echo '{"items":[{"metadata":{"name":"pod-1"}}]}'
    fi ;;
  */pods/pod-1/log\?container=precheck)
    if [[ $SCENARIO == invalid ]]; then
      echo '{"kind":"wrong","schemaVersion":2}'
    elif [[ $SCENARIO == stale ]]; then
      echo '{"kind":"krab-node-precheck","schemaVersion":2,"node":{"machineID":"machine-1","bootID":"old-boot","checkerVersion":"test-checker"}}'
    elif [[ $SCENARIO == legacy ]]; then
      echo '{"kind":"krab-node-precheck","schemaVersion":1}'
    else
      echo '{"kind":"krab-node-precheck","schemaVersion":2,"node":{"machineID":"machine-1","bootID":"boot-1","checkerVersion":"test-checker"}}'
    fi ;;
  *) printf 'Unexpected API request: %s\n' "$url" >&2; exit 1 ;;
esac
MOCK
chmod +x "$fixture_dir/bin/curl"
export PATH="$fixture_dir/bin:$PATH"
export SERVICE_ACCOUNT_DIR="$fixture_dir/serviceaccount"
export POD_NAMESPACE=krab-precheck OWNER_LABEL=krab-precheck CHECKER_VERSION=test-checker
export SCENARIO=success
for NODE_SELECTOR in 'kubernetes.io/os=linux' 'krab/preflight=true,kubernetes.io/os=linux'; do
  export NODE_SELECTOR
  bash "$collector" > "$fixture_dir/report.json"
  jq -e '.kind == "krab-cluster-precheck" and .schemaVersion == 2 and (.nodes | length) == 1 and .nodes[0].nodeName == "node-1"' "$fixture_dir/report.json" >/dev/null
done

export WAIT_FOR_DISPATCHER=true
export SCENARIO=success
bash "$collector" > "$fixture_dir/report.json"
export SCENARIO=dispatcher_failed
if bash "$collector" > "$fixture_dir/report.json" 2> "$fixture_dir/error"; then
  echo 'Collector unexpectedly accepted a failed dispatcher' >&2
  exit 1
fi
grep -F 'Dispatcher Job krab-precheck-dispatcher failed' "$fixture_dir/error" >/dev/null
export WAIT_FOR_DISPATCHER=false

for SCENARIO in failed missing duplicate invalid empty stale changed legacy; do
  export SCENARIO
  if bash "$collector" > "$fixture_dir/report.json" 2> "$fixture_dir/error"; then
    printf 'Collector unexpectedly accepted %s\n' "$SCENARIO" >&2
    exit 1
  fi
  case "$SCENARIO" in
    failed) expected='Node Job node-job did not succeed' ;;
    missing) expected='Node coverage mismatch' ;;
    duplicate) expected='Expected one pod for node-job' ;;
    invalid|stale|legacy) expected='Invalid report from node-1' ;;
    empty) expected='No Linux nodes match the pre-flight selector' ;;
    changed) expected='Selected nodes or their identities changed' ;;
  esac
  grep -F "$expected" "$fixture_dir/error" >/dev/null
done
printf 'Collector smoke tests passed\n'
