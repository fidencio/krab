#!/usr/bin/env bash
set -euo pipefail

name="${REFRESH_NAME:?}"
current="${REFRESH_CURRENT:-unknown}"
candidate="${REFRESH_TAG:-none}"

if [[ "${REFRESH_JOB_STATUS:-}" != success ]]; then
  result='Blocked'
  detail='A refresh step failed; check this job’s logs.'
elif [[ "${REFRESH_CHANGED:-}" != true ]]; then
  result='Current'
  detail='No eligible newer release was found.'
elif [[ -n "${REFRESH_PR_URL:-}" ]]; then
  result='Proposed'
  detail="[Review the pull request](${REFRESH_PR_URL}) before adopting this release."
else
  result='Ignored'
  detail='The candidate produced no pull request.'
fi

{
  printf '### %s\n\n' "$name"
  printf '| Pinned release | Candidate | Result |\n'
  printf '| --- | --- | --- |\n'
  printf '| %s | %s | %s |\n\n' "$current" "$candidate" "$result"
  printf '%s\n' "$detail"
} >> "${GITHUB_STEP_SUMMARY:?}"
