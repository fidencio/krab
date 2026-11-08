# CI and PR artifacts

The automation follows [NVIDIA/NVRC](https://github.com/NVIDIA/nvrc), adapted to KRAB's three independent Rust crates and static website.

Every PR builds a website preview. The bot links it after Pages publishes it. In the **Build PR preview** run, download `pr-deployments-<PR>-<head SHA>` for the packaged Helm chart, source configurations, generated values, rendered manifests, checksums, and exact build revision. These examples cover the five distributions and five generic amd64 runtimes. Unsupported combinations are recorded with their reason instead of rendered. Review values for your hardware before installing.

The deployment examples are render checks. Actual VM boot is verified by the **Kubernetes runtime smoke tests** workflow, which clones the pinned Kata repository and invokes its Kubernetes setup scripts, installs KRAB, and launches smoke pods. Its per-distribution artifacts contain values, manifests, pod logs, and diagnostics. PR examples retain the chart's published image pins; the smoke tests separately build and import the current PR's helper image into each ephemeral cluster.

The **Native CLI** workflow provides the three platform archives and checksums. It executes the binaries and terminal tests on each supported architecture. **Reproducible CLI** additionally compares two clean Linux builds with different source and Cargo-home paths. Both use `scripts/build-cli-release.py`, which creates an isolated virtual workspace so Cargo hashes all local package identities relative to one root. The ordinary independent crate manifests and lockfiles remain the development entry points.

Dependabot checks Rust crates daily and npm, Docker, and Actions weekly, with a seven-day cooldown. Updates use ordinary PR review and CI; automatic merging is not enabled.

**Rust quality** checks formatting, Clippy, tests, LLVM coverage, RustSec advisories, licenses, and dependency sources for every crate. RustSec vulnerabilities and unsound dependencies fail CI. Direct unmaintained dependencies fail the policy check; transitive maintenance notices remain visible in cargo-audit output. Coverage reports are downloadable; no arbitrary coverage threshold is imposed before a baseline is established. CodeQL scans Rust and Actions, zizmor scans workflow security, and actionlint checks workflow syntax.

Expensive checks stay outside the release path: weekly **Rust deep checks** run unused-dependency analysis, binary-size reports, and Miri for the shared CPU/profile policy code. Daily **Fuzzing** exercises the shared engine request parser and CPU kernel-parameter parser, uploading any crash input. Both workflows can be dispatched manually. These schedules become active after merge to the default branch.
