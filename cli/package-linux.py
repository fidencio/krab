"""Package already-tested Linux binaries for ORAS distribution."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--binary-dir', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
args.output.mkdir(parents=True, exist_ok=True)
inputs = sorted([*root.glob('cli/src/**/*'), *root.glob('core/src/**/*'), root/'core/Cargo.toml', root/'core/Cargo.lock', *root.glob('preflight/src/**/*'),
                 root/'cli/Cargo.toml', root/'cli/Cargo.lock', root/'preflight/Cargo.toml',
                 root/'src/generated/catalog.json',
                 root/'charts/krab/values.schema.json'])
fingerprint = hashlib.sha256()
for path in inputs:
    if path.is_file():
        fingerprint.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes())
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
metadata = {'version': json.loads((root/'package.json').read_text())['version'],
            'rustToolchain': '1.95.0', 'developmentBuild': True, 'builtAt': datetime.now(timezone.utc).isoformat(),
            'sourceRevision': revision, 'sourceSha256': fingerprint.hexdigest(),
            'linkage': 'static (musl)', 'platforms': ['linux/amd64', 'linux/arm64']}
archives = []
for architecture in ('x86_64', 'arm64'):
    name = f'krab-linux-{architecture}'
    archive = args.output / f'{name}.tar.gz'
    binary = args.binary_dir / architecture / 'krab'
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(binary, arcname=f'{name}/krab')
        tar.add(root/'cli/README.md', arcname=f'{name}/README.md')
        tar.add(root/'LICENSE', arcname=f'{name}/LICENSE')
        content = (json.dumps({**metadata, 'architecture': architecture}, indent=2)+'\n').encode()
        info = tarfile.TarInfo(f'{name}/BUILD-INFO.json')
        info.size = len(content)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(content))
    archives.append(archive)
(args.output/'BUILD-INFO.json').write_text(json.dumps(metadata, indent=2)+'\n')
(args.output/'README.txt').write_text('''KRAB CLI development build (Linux x86_64 and arm64)

Download the matching development artifacts from a successful Native CLI run:
  https://github.com/kata-containers/krab/actions/workflows/cli.yml

Verify:
  sha256sum -c SHA256SUMS

Select your architecture:
  x86_64 / amd64: tar -xzf krab-linux-x86_64.tar.gz
  aarch64 / arm64: tar -xzf krab-linux-arm64.tar.gz

Run the extracted krab binary to open the TUI. The first two actions run a
node pre-check or cluster conformance. Remote checks need Helm, kubectl, and
a usable kubeconfig (KUBECONFIG or ~/.kube/config, or select a file in the TUI).
The binaries are statically linked and do not require a system glibc version.

CLI examples:
  krab precheck --node worker-1 --context my-cluster --output node.json
  krab conformance --run --context my-cluster --require kvm --failed-nodes
  krab conformance --run --context my-cluster --require tdx --failed-nodes

Conformance verifies reported host prerequisites, not workload launch or attestation.
See the README.md inside each archive for full usage. BUILD-INFO.json identifies
this development source snapshot; SHA256SUMS covers the distributed files.
''')
files = [*archives, args.output/'BUILD-INFO.json', args.output/'README.txt']
(args.output/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in files))
for path in files:
    print(f'{path.name}: {path.stat().st_size} bytes')
