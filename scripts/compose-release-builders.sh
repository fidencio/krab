#!/usr/bin/env bash

set -euo pipefail

site="${1:?site directory required}"
repo="${GH_REPO:?GH_REPO required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${site}/releases"
cp "${script_dir}/../public/releases/release-notice.js" "${site}/releases/release-notice.js"

releases="$(mktemp)"
manifest_rows="$(mktemp)"
downloads="$(mktemp -d)"
trap 'rm -f "${releases}" "${manifest_rows}"; rm -rf "${downloads}"' EXIT

gh api "repos/${repo}/releases" --paginate \
  --jq '.[] | select(.draft == false) | [.tag_name, .prerelease] | @tsv' > "${releases}"

while IFS=$'\t' read -r tag prerelease; do
  [[ -n "${tag}" ]] || continue
  if [[ "${prerelease}" == "true" ]]; then
    continue
  fi
  if [[ ! "${tag}" =~ ^chart-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    echo "::error::Published KRAB release has an invalid tag: ${tag}" >&2
    exit 1
  fi

  version="${BASH_REMATCH[1]}"
  asset="krab-builder-${version}.tar.gz"
  archive_dir="${downloads}/${version}"
  destination="${site}/releases/${version}"
  mkdir -p "${archive_dir}" "${destination}"
  if ! gh release download "${tag}" --repo "${repo}" \
    --pattern "${asset}" --dir "${archive_dir}"; then
    echo "::error::Published release ${tag} is missing ${asset}" >&2
    exit 1
  fi
  if [[ ! -f "${archive_dir}/${asset}" ]]; then
    echo "::error::Published release ${tag} is missing ${asset}" >&2
    exit 1
  fi
  if tar -tzf "${archive_dir}/${asset}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "::error::Unsafe path in ${asset}" >&2
    exit 1
  fi
  tar -xzf "${archive_dir}/${asset}" -C "${destination}"
  if [[ ! -f "${destination}/index.html" ]]; then
    echo "::error::${asset} has no index.html" >&2
    exit 1
  fi
  cp "${destination}/index.html" "${downloads}/root-index-${version}.html"
  node "${script_dir}/inject-release-notice.mjs" "${destination}/index.html" "${version}"
  printf '%s\t%s\t%s\n' "${version}" "${tag}" "./${version}/index.html" >> "${manifest_rows}"
done < "${releases}"

jq -R -s \
  '{schemaVersion: 1, releases: (split("\n") | map(select(length > 0) | split("\t") | {version: .[0], tag: .[1], path: .[2]}) | sort_by(.version | split(".") | map(tonumber)) | reverse)} | .currentVersion = (.releases[0].version // null)' \
  "${manifest_rows}" > "${site}/releases/manifest.json"

latest_version="$(jq -r '.currentVersion // empty' "${site}/releases/manifest.json")"
if [[ -n "${latest_version}" ]]; then
  cp "${downloads}/root-index-${latest_version}.html" "${site}/index.html"
else
  cp "${site}/dev/index.html" "${site}/index.html"
fi
