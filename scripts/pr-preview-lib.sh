#!/usr/bin/env bash

set -euo pipefail

list_open_previews() {
  gh pr list --repo "${GH_REPO}" --state open --limit 1000 \
    --json number,headRefOid --jq '.[] | [.number, .headRefOid] | @tsv'
}

preview_run() {
  local name="pr-preview-${1}-${2}"
  local run_id
  run_id="$(gh api --method GET "repos/${GH_REPO}/actions/artifacts" \
    -f "name=${name}" \
    --jq '[.artifacts[] | select(.expired == false)][0].workflow_run.id // empty')"
  [[ -n "${run_id}" ]] || return 0
  gh api "repos/${GH_REPO}/actions/runs/${run_id}" \
    --jq 'select(.path == ".github/workflows/pr-preview.yml" and .conclusion == "success") | .id'
}
