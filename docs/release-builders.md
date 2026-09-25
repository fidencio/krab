# Builders for older KRAB releases

## Decision

Keep a fully usable builder for each official KRAB release. The released
builder must use the catalog, chart version, and values format from that
release. A release tab opens that build, so users can generate values for an
older deployment without silently switching to current defaults.

The `main` and `dev` builders remain separate from official releases. A Git
tag alone does not make a release visible: only a published `chart-v*` GitHub
release gets a tab. This includes prereleases while KRAB is in alpha.

## Publication

The chart release workflow should build the site with
`BASE_PATH=/<repo>/releases/<version>/` and attach a compressed `dist` archive
to the same GitHub release as the charts. The archive is immutable for that
version. A rerun should compare the existing archive before accepting it,
just as the workflow compares an already published chart.

The Pages workflow should list published releases, download their site
archives, and extract them under `/releases/<version>/`. It should generate a
small release manifest from those same published releases. A navigation page
can use the manifest to show one tab per version and keep the selected builder
open while switching tabs. It should fail if a published release lacks a
builder archive; silently omitting that tab would make older installations
hard to reproduce.

Existing releases have no site archive. Backfill each one from its release tag
once, using its locked dependencies and base path, then attach the resulting
archive after checking the tag and chart version. Do this as a reviewable
backfill, rather than making every Pages deployment rebuild old source with
the current Node and Vite toolchain. If a tag cannot be built, record the
failure and resolve it before advertising a tab for that release.

## Values imported across releases

Each tab uses its own chart schema to validate imported values. The current
builder warns when an older compatible file loads and rejects unsupported
fields or choices. A historical builder should keep its own import behavior;
the archive preserves it as part of that release. The version comments added
to downloaded values identify the format and chart version for future
migrations.

The released site archives will add storage and deployment size as releases
accumulate. Track Pages artifact size as part of publication. If it becomes a
limit, move old immutable archives to a separate static host while keeping the
same versioned URLs and manifest contract.
