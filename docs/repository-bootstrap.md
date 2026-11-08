# Bootstrap kata-containers/krab

This import contains the KRAB 0.2.11 codebase, product-profile fixes, and the
Confidential Containers demo in one initial commit. The Apache-2.0 license and
existing author attribution are retained. It starts a new Git history; release
assets, tags, package permissions, repository settings, and workflow runs are
not part of that commit.

## Install the initial commit

Create an empty `kata-containers/krab` repository, without an automatically
created README, license, or initial commit. From the prepared migration checkout:

```sh
git remote add kata https://github.com/kata-containers/krab.git
git push kata HEAD:main
```

Alternatively, clone the supplied Git bundle and push its single branch as main.
Do not merge the import into another history if a single initial commit is required.

## Configure GitHub

- Set `main` as the default branch. Enable Issues and the desired merge policy.
- Enable Actions and permit the pinned actions used in `.github/workflows/`.
- Enable GitHub Pages with **GitHub Actions** as its source and allow `main` to
  deploy through the `github-pages` environment. The expected site is
  `https://kata-containers.github.io/krab/`.
- Allow the repository's `GITHUB_TOKEN` to publish packages and artifact attestations.
  The release workflow already declares its required permissions. If any of the
  four package names below already exist, grant this repository Actions access.
- Enable Dependabot version/security updates and dependency graph support.
  The update configuration is included in `.github/dependabot.yml`.
- Configure branch protection/rulesets after the first workflows establish their
  check names. Include the website/chart, Rust, native binary, and runtime smoke
  checks according to the project's policy.

Upstream pin updates are handled by a maintenance agent using the manual
commands in the README. No upstream-refresh workflow, PR-creation action, or
Slack credentials are required.

No personal access token is required by the release workflow. Organization policies
must allow its `GITHUB_TOKEN` permissions and the `github-pages` environment.

## Publish the first release

The imported version is **0.2.11**. Run the checks on the imported `main` first;
then dispatch **Release KRAB Helm chart** from that branch. The workflow builds
fresh artifacts for this repository and creates `chart-v0.2.11`. Do not copy
previously built binaries or static builders: their embedded catalogs, links,
image defaults, revision metadata, and provenance identify a different build.

The first release must publish these packages and make them publicly readable:

| Package | Purpose |
| --- | --- |
| `ghcr.io/kata-containers/krab` | Main Helm chart |
| `ghcr.io/kata-containers/krab-precheck` | Pre-check Helm chart |
| `ghcr.io/kata-containers/krab-preflight` | Node checker/staging image |
| `ghcr.io/kata-containers/krab-collector` | Cluster collection image |

The release workflow checks anonymous access. If organization policy prevents
public visibility, resolve that policy before advertising the release. Repository
links are `https://github.com/kata-containers/krab`; attestations must verify
against `kata-containers/krab`.

Before a release exists, Pages serves the development builder. Stable downloads
and deployments using the new image/chart namespace need the first publication.
After release, verify the Pages site selects the matching stable builder, the
three native CLI downloads and their checksums, and both charts' anonymous pulls.
Run a smoke deployment with the published packages.

## Local validation

```sh
npm ci
npm run generate
npm run build:core
npm test
npm run lint
npm run build
```

The browser engine build needs the Rust toolchain pinned by `scripts/build-core.py`
and its `wasm32-unknown-unknown` target. Also run the native Rust CI workflows and
Kubernetes distribution smoke matrix on the destination repository before release.

The [CoCo demo](../demo/confidential-containers/README.md) uses the same engine
with a mounted profile and logo. It requires no separate repository or frontend.
