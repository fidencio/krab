# Website walkthroughs

The on-site guide is implemented in `src/Documentation.tsx`. Its videos, posters,
and WebVTT captions are served directly from `public/walkthroughs/`; readers do
not need another site or account. `src/generated/walkthroughs.json` contains
recorded versions, durations, and text transcripts. Playback is user-initiated.

The terminal clips capture real KRAB sessions through a PTY. The recorder
reuses the terminal integration-test driver and decodes actual terminal output,
including cursor updates and colors. The website clip captures the actual local
builder while selecting Custom, amd64, kubeadm, and QEMU and exporting its
configuration. No cluster or deployment is simulated in these clips.

To regenerate after a UI or CLI change, use a built Unix CLI and Chrome:

```sh
python3 scripts/record-terminal.py --binary cli/target/debug/krab --output /tmp/krab-recordings
node scripts/record-website.mjs /tmp/krab-recordings/website.json
node scripts/render-walkthrough.mjs /tmp/krab-recordings/tui.json tui public/walkthroughs src/generated/walkthroughs.json
node scripts/render-walkthrough.mjs /tmp/krab-recordings/cli.json cli public/walkthroughs src/generated/walkthroughs.json
node scripts/render-walkthrough.mjs /tmp/krab-recordings/website.json website public/walkthroughs src/generated/walkthroughs.json
```

Run browser recordings and renders sequentially. Set `KRAB_CHROME` when Chrome
is at a non-default location. The default is the macOS application binary;
terminal capture can run on Linux and be copied to the rendering host.

The renderer converts recorded states into legible WebM clips using Chrome's
canvas and MediaRecorder APIs, with captions showing each real action. It also
writes a poster, WebVTT captions, and the text transcript. Terminal replay uses
larger text at 100 columns. The WebM Info duration is filled explicitly so native
browser controls can seek normally. There is no audio track; both burned-in
captions and optional browser captions communicate the steps.

Before committing, play and seek each video in the on-site guide, check captions,
read the transcripts, and verify the documentation at desktop and phone widths.
The documentation tests require the complete set of assets for every recording.
