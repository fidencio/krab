#!/usr/bin/env bash
# Assemble one report from every explicitly labeled Linux node.
set -euo pipefail

api=https://kubernetes.default.svc
token=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
ca=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
namespace=${POD_NAMESPACE:?}
owner=${OWNER_LABEL:?}
selector=${NODE_SELECTOR:?}

get() {
  curl -fsS --cacert "$ca" -H "Authorization: Bearer $token" "$api$1"
}
list() {
  curl -fsS --cacert "$ca" -H "Authorization: Bearer $token" \
    --get --data-urlencode "labelSelector=$2" "$api$1"
}

nodes=$(list /api/v1/nodes "$selector")
jobs=$(list "/apis/batch/v1/namespaces/$namespace/jobs" "$owner/owner=$owner")
dispatcher=$(get "/apis/batch/v1/namespaces/$namespace/jobs/$owner-dispatcher")
dispatcher_uid=$(jq -r '.metadata.uid' <<<"$dispatcher")
expected=$(jq -c '[.items[].metadata.name] | sort' <<<"$nodes")
if [[ $(jq length <<<"$expected") == 0 ]]; then
  echo 'No Linux nodes have the requested pre-flight label' >&2
  exit 1
fi

results='[]'
while IFS= read -r job; do
  name=$(jq -r '.metadata.name' <<<"$job")
  node=$(jq -r '.spec.template.spec.nodeName' <<<"$job")
  if [[ $(jq -r '.status.succeeded // 0' <<<"$job") != 1 ]]; then
    echo "Node Job $name did not succeed" >&2
    exit 1
  fi
  pods=$(list "/api/v1/namespaces/$namespace/pods" "batch.kubernetes.io/job-name=$name")
  if [[ $(jq '.items | length' <<<"$pods") != 1 ]]; then
    echo "Expected one pod for $name" >&2
    exit 1
  fi
  pod=$(jq -r '.items[0].metadata.name' <<<"$pods")
  report=$(get "/api/v1/namespaces/$namespace/pods/$pod/log?container=precheck")
  if ! jq -e '.kind == "krab-node-precheck" and .schemaVersion == 1' <<<"$report" >/dev/null; then
    echo "Invalid report from $node" >&2
    exit 1
  fi
  results=$(jq -c --arg node "$node" --argjson report "$report" \
    '. + [{nodeName:$node,report:$report}]' <<<"$results")
done < <(jq -c --arg uid "$dispatcher_uid" '.items[] | select(any(.metadata.ownerReferences[]?; .uid == $uid))' <<<"$jobs")

actual=$(jq -c '[.[].nodeName] | sort' <<<"$results")
if [[ $actual != "$expected" ]]; then
  echo "Node coverage mismatch: expected $expected, got $actual" >&2
  exit 1
fi
jq -n --argjson results "$results" \
  '{kind:"krab-cluster-precheck",schemaVersion:1,nodes:$results}'
