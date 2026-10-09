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
    if [[ $SCENARIO == missing ]]; then
      echo '{"items":[{"metadata":{"name":"node-1"}},{"metadata":{"name":"node-2"}}]}'
    else
      echo '{"items":[{"metadata":{"name":"node-1"}}]}'
    fi ;;
  */jobs/krab-precheck-dispatcher)
    echo '{"metadata":{"uid":"current-dispatcher"}}' ;;
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
      echo '{"kind":"wrong","schemaVersion":1}'
    else
      echo '{"kind":"krab-node-precheck","schemaVersion":1}'
    fi ;;
  *) printf 'Unexpected API request: %s\n' "$url" >&2; exit 1 ;;
esac
MOCK
chmod +x "$fixture_dir/bin/curl"
export PATH="$fixture_dir/bin:$PATH"
export SERVICE_ACCOUNT_DIR="$fixture_dir/serviceaccount"
export POD_NAMESPACE=krab-precheck OWNER_LABEL=krab-precheck NODE_SELECTOR='krab/preflight=true,kubernetes.io/os=linux'
export SCENARIO=success
bash "$collector" > "$fixture_dir/report.json"
jq -e '.kind == "krab-cluster-precheck" and .schemaVersion == 1 and (.nodes | length) == 1 and .nodes[0].nodeName == "node-1"' "$fixture_dir/report.json" >/dev/null

for SCENARIO in failed missing duplicate invalid; do
  export SCENARIO
  if bash "$collector" > "$fixture_dir/report.json" 2> "$fixture_dir/error"; then
    printf 'Collector unexpectedly accepted %s\n' "$SCENARIO" >&2
    exit 1
  fi
  case "$SCENARIO" in
    failed) expected='Node Job node-job did not succeed' ;;
    missing) expected='Node coverage mismatch' ;;
    duplicate) expected='Expected one pod for node-job' ;;
    invalid) expected='Invalid report from node-1' ;;
  esac
  grep -F "$expected" "$fixture_dir/error" >/dev/null
done
printf 'Collector smoke tests passed\n'
