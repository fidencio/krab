#!/usr/bin/env bash
set -euo pipefail

: "${SLACK_BOT_TOKEN:?Set the KRAB_SLACK_BOT_TOKEN repository secret}"
: "${SLACK_USER_ID:?Set the KRAB_SLACK_USER_ID repository variable}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_SERVER_URL:?}"

failed=()
[[ "${PIN_STATUS:-}" == success ]] || failed+=("Pinned source check: ${PIN_STATUS:-unknown}")
[[ "${UPSTREAM_STATUS:-}" == success ]] || failed+=("Upstream release refresh: ${UPSTREAM_STATUS:-unknown}")
[[ "${EROFS_STATUS:-}" == success ]] || failed+=("EROFS image refresh: ${EROFS_STATUS:-unknown}")

details="$(printf '• %s\n' "${failed[@]}")"
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
message="$(printf 'KRAB upstream refresh needs attention.\n%s\n<%s|Open workflow run>' "$details" "$run_url")"
payload="$(jq -n --arg channel "$SLACK_USER_ID" --arg text "$message" \
  '{channel: $channel, text: $text}')"

response="$(curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  --header 'Content-Type: application/json; charset=utf-8' \
  --data "$payload" \
  https://slack.com/api/chat.postMessage)"

if ! jq -e '.ok == true' >/dev/null <<< "$response"; then
  error="$(jq -r '.error // "unknown Slack error"' <<< "$response")"
  echo "Slack rejected the refresh notification: ${error}" >&2
  exit 1
fi

echo 'Sent Slack DM about the blocked upstream refresh.'
