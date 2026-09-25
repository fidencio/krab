#!/usr/bin/env bash
set -euo pipefail

current_sha="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')"
if [[ "${current_sha}" != "${GITHUB_SHA}" ]]; then
  echo "::error::main moved from ${GITHUB_SHA} to ${current_sha}. Dispatch the release again from current main."
  exit 1
fi
