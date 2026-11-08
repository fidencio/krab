#!/usr/bin/env bash

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pr-preview-lib.sh"

site="${1:?site directory required}"
preview_list="$(mktemp)"
trap 'rm -f "${preview_list}"' EXIT
list_open_previews > "${preview_list}"

while IFS=$'\t' read -r number sha; do
  [[ -n "${number}" && -n "${sha}" ]] || continue
  run_id="$(preview_run "${number}" "${sha}")"
  if [[ -z "${run_id}" ]]; then
    echo "No completed preview for PR #${number} at ${sha}"
    continue
  fi

  destination="${site}/pr/${number}"
  mkdir -p "${destination}"
  gh run download "${run_id}" --repo "${GH_REPO}" \
    --name "pr-preview-${number}-${sha}" --dir "${destination}"
done < "${preview_list}"
