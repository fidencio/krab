# Builders for older KRAB releases

## Decision

Keep a fully usable builder for each official KRAB release. The released
builder must use the catalog, chart version, and values format from that
release. A version menu link opens that build, so users can generate values
for an older deployment without silently switching to current defaults.

The home page uses the newest published stable release. Next at `/dev/` builds
from `main`, so work merged after that release remains available. It shows a
notice and links back to the stable release. A Git
tag alone does not make a release visible: only a published, stable `chart-v*`
GitHub release appears in the menu. Prereleases are excluded.

## Publication

The chart release workflow builds the site with
`BASE_PATH=/<repo>/releases/<version>/` and attaches a compressed `dist` archive
to the same GitHub release as the charts. A rerun compares an existing archive
with the rebuilt site before accepting it, just as it compares published charts.

The Pages workflow lists published stable releases, downloads their site
archives, and extracts them under `/releases/<version>/`. It generates a small
release manifest from those same published releases, sorts them by version,
and serves the newest archived builder at the home page. If no stable release
exists yet, the home page uses Next. Builders with the version menu
read the manifest and link directly to the selected archive or `/dev/`. Pages adds
a notice to archived pages when their version differs from the current builder,
with a link back to it. The release archives themselves stay unchanged.
Pages fails if a published stable release lacks a builder archive; silently
omitting that version would make older installations hard to reproduce.

Existing prereleases have no site archive and are excluded from the published
selector. Before listing historical stable releases, backfill each from its
release tag once, using its locked dependencies and base path, then attach the
archive after checking the tag and chart version. Pages must not rebuild old
source with the current Node and Vite toolchain on every deployment.

## Values imported across releases

Each builder uses its own chart schema to validate imported values. The current
builder warns when an older compatible file loads and rejects unsupported
fields or choices. A historical builder should keep its own import behavior;
the archive preserves it as part of that release. The version comments added
to downloaded values identify the format and chart version for future
migrations.

The released site archives will add storage and deployment size as releases
accumulate. Track Pages artifact size as part of publication. If it becomes a
limit, move old immutable archives to a separate static host while keeping the
same versioned URLs and manifest contract.
