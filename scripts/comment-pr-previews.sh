#!/usr/bin/env bash

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pr-preview-lib.sh"

preview_list="$(mktemp)"
trap 'rm -f "${preview_list}"' EXIT
list_open_previews > "${preview_list}"

while IFS=$'\t' read -r number sha; do
  [[ -n "${number}" && -n "${sha}" ]] || continue
  run_id="$(preview_run "${number}" "${sha}")"
  comment_id="$(gh api --paginate "repos/${GH_REPO}/issues/${number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- krab-pr-preview -->"))) | .id' \
    | sed -n '1p')"
  if [[ -z "${run_id}" ]]; then
    if [[ -n "${comment_id}" ]]; then
      gh api --method PATCH "repos/${GH_REPO}/issues/comments/${comment_id}" \
        -f 'body=<!-- krab-pr-preview -->
The rendered preview is unavailable for the current PR revision. Check the Build PR preview workflow.' >/dev/null
    fi
    continue
  fi

  url="${PAGES_URL%/}/pr/${number}/"
  body="<!-- krab-pr-preview -->
Rendered KRAB preview for this PR: ${url}"
  if [[ -n "${comment_id}" ]]; then
    gh api --method PATCH "repos/${GH_REPO}/issues/comments/${comment_id}" \
      -f "body=${body}" >/dev/null
  else
    gh api --method POST "repos/${GH_REPO}/issues/${number}/comments" \
      -f "body=${body}" >/dev/null
  fi
done < "${preview_list}"
