"""Package a tested native KRAB CLI reproducibly, including completions."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import runpy
import struct
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--platform', choices=['linux-amd64', 'linux-arm64', 'darwin-arm64'], required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--epoch', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text())['version']
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', args.revision):
        parser.error('revision must be a full commit hash')
    if not 0 <= args.epoch <= 0o77777777777:
        parser.error('invalid source epoch')
    binary = args.binary.resolve()
    data = binary.read_bytes()
    system, architecture = args.platform.split('-')
    try:
        if system == 'linux':
            runpy.run_path(str(root / 'scripts/package-preflight-binary.py'))['verify_elf'](data, architecture)
        elif len(data) < 32 or data[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', data, 4)[0] != {'amd64': 0x1000007, 'arm64': 0x100000c}[architecture]:
            raise ValueError('binary must be a matching 64-bit Mach-O executable')
    except ValueError as error:
        parser.error(str(error))
    actual = subprocess.check_output([str(binary), '--version'], text=True).strip()
    if actual != f'krab {version}':
        parser.error(f'binary version {actual!r} does not match KRAB {version}')
    digest = hashlib.sha256(data).hexdigest()
    entries = {
        'krab': data,
        'README.md': (root / 'cli/README.md').read_bytes(),
        'LICENSE': (root / 'LICENSE').read_bytes(),
        'CPU-CC.md': (root / 'docs/nvidia-cpu-confidential.md').read_bytes(),
        'SHA256SUMS': f'{digest}  krab\n'.encode(),
        'BUILD-INFO.json': (json.dumps({
            'version': version, 'revision': args.revision, 'platform': args.platform,
            'linkage': 'static-musl' if system == 'linux' else 'native',
            'binarySHA256': digest, 'sourceDateEpoch': args.epoch,
            'catalogSHA256': hashlib.sha256((root / 'src/generated/catalog.json').read_bytes()).hexdigest(),
        }, indent=2, sort_keys=True) + '\n').encode(),
    }
    for shell in ['bash', 'zsh', 'fish']:
        entries[f'completions/krab.{shell}'] = subprocess.check_output([str(binary), 'completions', shell])
    args.output.mkdir(parents=True, exist_ok=True)
    archive_path = args.output / f'krab-{version}-{args.platform}.tar.gz'
    with archive_path.open('wb') as output:
        with gzip.GzipFile(filename='', fileobj=output, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name, content in sorted(entries.items()):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = 0o755 if name == 'krab' else 0o644
                    info.mtime = args.epoch
                    info.uname = info.gname = 'root'
                    archive.addfile(info, io.BytesIO(content))
    print(archive_path)


if __name__ == '__main__':
    main()
