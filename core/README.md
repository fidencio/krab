# Shared KRAB engine

This crate is the authoritative implementation of configuration defaults,
selection validation, chart-schema validation, and Helm values generation. It
also imports NVIDIA CPU CC overlays. The native CLI imports this crate directly;
the website runs it as WebAssembly. TypeScript adapts form state and renders the
interface and imports existing values. Rust also formats the resulting YAML. It does not
maintain a second values generator or chart-schema validator.

The pinned catalog is assembled from upstream inputs by `npm run generate` and
embedded in the engine. The website reads its catalog and defaults from that
engine. Both clients therefore use the same definitions and validation rules.

## Build the browser engine

```sh
rustup toolchain install 1.95.0 --profile minimal --target wasm32-unknown-unknown
npm ci
npm run generate
npm run build:core
npm test
npm run build
```

`build-core.py` compiles the exact library used by the CLI, including its schema
validator. It obtains a wasm-bindgen tool matching `core/Cargo.lock`, verifies
its download checksum, and produces browser bindings. To use an already installed
matching tool, set `KRAB_WASM_BINDGEN` or supply `--bindgen` to the script.
The default development hosts are Linux and macOS.

Outputs under `src/generated/engine/` and `core-build.json` are build artifacts,
not a separately maintained implementation. CI recreates them before testing or
building a website. Source, catalog, schema, lockfile, binding, and binary hashes
are checked before build, test, or dev to catch stale local builds.

The WebAssembly module communicates through an owned JSON buffer ABI. The
binding layer supplies browser randomness used by dependencies. It needs no
filesystem, shell, cluster credentials, deployment service, or application
backend. All configuration work happens in the visitor's browser.

## Generate command documentation

Build the matching native CLI, then run:

```sh
cargo +1.95.0 build --locked --manifest-path cli/Cargo.toml
python3 scripts/generate-cli-reference.py --binary cli/target/debug/krab
```

The on-site command reference is generated from actual `--help` output, including
its flags and defaults. Every native CI platform compares its real binary with
the committed reference using `--check`. Update the reference after changing the
CLI's command interface.

## Verify both clients

The existing model and schema tests now exercise the Rust engine through its
browser build. Native CLI tests exercise the same library directly. The parity
matrix compares native and browser results across distributions, architectures,
runtimes, hardware modes, advanced settings, and node-derived NVIDIA CPU TDX/SNP
profiles. A separate check prevents stale or tampered generated engine files
from passing website builds.

Draft previews allow incomplete selections for editing. Saving, downloading,
and deploying require full configuration and chart-schema validation. The same
code builds values for previews and validated configurations.
