# Run your own KRAB product

Deploy the same static website and native CLI with an operator-owned JSON profile. The shared Rust engine filters available choices, validates defaults, and keeps disabled settings fixed at those defaults. The website also omits disabled controls. Both interfaces retain **Powered by KRAB** attribution. This does not change the repository's Apache-2.0 license.

Product profiles are available in KRAB 0.2.11 and later. Use matching website and CLI releases, or development artifacts from the same source revision.

## Run the website

Build the container from your chosen source revision. Docker builds Rust/WASM and the website; the running container only serves static files.

```sh
docker build -f Dockerfile.website -t krab-website .
docker run --rm -p 8080:80 \
  -v "$PWD/examples/product-profiles/coco.json:/usr/share/nginx/html/krab-profile.json:ro" \
  -v "$PWD/src/assets/brands/confidential-containers.svg:/usr/share/nginx/html/product-logo.svg:ro" \
  krab-website
```

Open `http://localhost:8080`. Without the profile mount, the image serves the ordinary KRAB builder. Edit the mounted JSON and reload to change the product; no image rebuild is needed. Invalid or unavailable profiles block the builder with an explanatory error. A missing profile file selects the ordinary builder.

The **Self-hosted website** CI artifact contains the same portable static files, built with relative asset URLs. Serve them from any static host, including a subdirectory. Copy a profile to `krab-profile.json` beside `index.html`, and copy its logo asset alongside it. No Node.js, Rust, application server, or cluster credentials are needed on that host.

## Use the matching CLI

Download the native archive for your platform from the same revision's **Native CLI** run. A product can redistribute those binaries together with its profile:

```sh
krab --profile examples/product-profiles/coco.json list catalog --json
krab --profile examples/product-profiles/coco.json init --non-interactive --output coco.yaml
krab --profile examples/product-profiles/coco.json edit --config coco.yaml
krab --profile examples/product-profiles/coco.json generate --config coco.yaml --output values.yaml
```

`KRAB_PROFILE=/path/to/profile.json` also works. For a bundled CLI, place `krab-profile.json` beside the executable; it loads automatically. An explicit `--profile` takes precedence over the environment and bundled profile. The TUI uses the product name and retains KRAB attribution; the development TUI can also show a local PNG logo on graphics-capable terminals.
Relative logo paths resolve beside the profile file. HTTPS URLs and unsupported
formats remain website assets; the TUI keeps its product heading without fetching them.

## Configure the profile

For a runnable CoCo-branded site with Intel, AMD, IBM, and NVIDIA choices, see
[the Confidential Containers demo](../demo/confidential-containers/README.md).

Start with [the CoCo example](../examples/product-profiles/coco.json). It illustrates an amd64 CoCo-dev product with Nydus, without NVIDIA hardware choices or editable image pins. CoCo-dev is a development runtime without a hardware TEE. For a confidential workload product, select the appropriate TDX/SNP runtimes and test them on matching hardware. The example is not an official CoCo distribution.

| Field | Purpose |
| --- | --- |
| `apiVersion` | `krab/product/v1alpha1` |
| `id`, `name`, `description` | Product identity and website/TUI title |
| `logo` | Optional relative website asset path or HTTPS image URL |
| `theme.light`, `theme.dark` | Optional website and TUI colours for each appearance mode |
| `available.vendors` | Allowed existing vendor/path IDs |
| `available.runtimes` | Allowed existing runtime IDs, across the selected vendors |
| `available.distributions` | Allowed Kubernetes distribution IDs |
| `available.architectures` | Allowed architecture IDs |
| `available.hardwareFamilies` | Allowed hardware family IDs; use `[]` for CPU-only products |
| `defaults` | Partial native KRAB configuration, using the same fields as `krab init` exports |

Omit an availability list to retain its existing choices. Empty required lists, unknown IDs or fields, incompatible defaults, and duplicate entries fail validation. Runtime reference data and chart versions remain pinned to the matching KRAB build. Removing GPU choices also removes GPU family modes that depend on them. Existing distribution compatibility checks still apply.

Feature flags default to `true`. Set any of these to `false`:

| Feature | Settings held at product defaults |
| --- | --- |
| `advanced` | All advanced, runtime, and component settings |
| `customRuntimes` | Custom RuntimeClasses |
| `continuousConformance` | Continuous host conformance |
| `newNodes` | Scheduled enrollment and its cron schedule |
| `imageOverrides` | Component images and the EROFS utility image |
| `components` | Component installation choices |
| `helmOverrides` | Raw Helm value overrides in the native editor |

A disabled feature can still be enabled by the operator in `defaults`; end users cannot change it through that configured product. Imported configurations use the same checks. Raw Helm overrides cannot bypass disabled features or restricted availability lists, and are not supported in product defaults. The profile configures the product; Kubernetes permissions and authorization remain the cluster operator's responsibility.

Validate a profile offline with `krab --profile profile.json list catalog --json`. Inspect `product.defaults` in that output for the engine's fully resolved starting configuration.

## Set website and TUI colours

Add `theme.light` and/or `theme.dark` to `krab-profile.json`. Each palette accepts `pageBackground`, `panelBackground`, `text`, `mutedText`, `accent`, and `border` as opaque `#RGB` or `#RRGGBB` colours. For example:

```json
"theme": {
  "light": { "pageBackground": "#f4f8fc", "panelBackground": "#fff", "text": "#152d45", "accent": "#006b9e" },
  "dark": { "pageBackground": "#091827", "panelBackground": "#122a3e", "text": "#edf6ff", "accent": "#62c8ff" }
}
```

The website follows the visitor's system preference and its light/dark toggle. Omitted colours retain KRAB's palette for that mode; the example profile includes matching muted text and borders. Choose text and backgrounds with sufficient contrast; text on solid accent buttons automatically uses black or white. Replace the profile file and reload to apply changes, without rebuilding the website or WASM. Unknown fields and invalid colours block the profile with an explanation.

The TUI maps the same six fields onto page and panel backgrounds, body and muted
text, headings and selections, and borders, including the cluster-check screens.
Selected rows use black or white text for contrast with the accent colour.
Validation and message emphasis use the supplied accent (or text colour),
with explicit status labels retained.
It detects a light or dark terminal through its background-colour response, then
uses `COLORFGBG` when available, and otherwise selects the dark palette.
Use `KRAB_THEME=light`, `KRAB_THEME=dark`, or `KRAB_THEME=auto` to override that
choice. Restart the TUI after changing the profile; no rebuild is needed.
Omitted colours retain terminal defaults or inherit the supplied page/text colours;
without a palette, the existing terminal appearance is preserved. True-colour
terminals display the supplied RGB values; other terminals may approximate them.

Theme settings do not change generated deployments. This TUI mapping is newer
than the 0.3.0 release; use a matching development build until the next release.
