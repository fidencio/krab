"""Build the browser engine from the exact Rust library and validator used by the CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request


def release_api_url(url):
    match = re.fullmatch(
        r'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/([^/]+)/([^/]+)', url)
    if not match:
        return None
    version, filename = match.groups()
    endpoint = f'https://api.github.com/repos/wasm-bindgen/wasm-bindgen/releases/tags/{version}'
    request = urllib.request.Request(f'{endpoint}?krab_retry={time.time_ns()}', headers={
        'User-Agent': 'KRAB-build', 'Cache-Control': 'no-cache',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    for asset in release['assets']:
        if asset['name'] == filename:
            return f'https://api.github.com/repos/wasm-bindgen/wasm-bindgen/releases/assets/{int(asset["id"])}'
    raise RuntimeError(f'Locked wasm-bindgen release asset is missing: {filename}')


def download(url):
    """Retry transient release-host errors; the caller verifies the checksum."""
    api_url = None
    for attempt in range(3):
        try:
            if attempt and api_url is None:
                api_url = release_api_url(url)
            target = api_url or url
            separator = '&' if '?' in target else '?'
            request_url = target if attempt == 0 else f'{target}{separator}krab_retry={time.time_ns()}'
            headers = {'User-Agent': 'KRAB-build', 'Cache-Control': 'no-cache'}
            if api_url:
                headers['Accept'] = 'application/octet-stream'
            request = urllib.request.Request(request_url, headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code != 429 and not 500 <= error.code < 600:
                raise
            if attempt == 2:
                raise
            print(f'Retrying wasm-bindgen download after {error} (retry {attempt + 1}/2)', file=sys.stderr)
            time.sleep(2 ** attempt)


def source_files(root):
    return sorted([*root.glob('core/src/**/*.rs'), root/'core/Cargo.toml', root/'core/Cargo.lock',
                   root/'scripts/build-core.py', root/'src/generated/catalog.json',
                   root/'charts/krab/values.schema.json', root/'upstream/erofs-utils-image.lock.json'])


def binding_tool(root, supplied, toolchain):
    version = re.search(r'name = "wasm-bindgen"\nversion = "([^"]+)"',
                        (root/'core/Cargo.lock').read_text()).group(1)
    if supplied:
        executable = Path(supplied).resolve()
    elif shutil.which('wasm-bindgen') and subprocess.check_output([shutil.which('wasm-bindgen'), '--version'], text=True).strip() == f'wasm-bindgen {version}':
        executable = Path(shutil.which('wasm-bindgen'))
    else:
        architecture = {'arm64': 'aarch64', 'aarch64': 'aarch64', 'x86_64': 'x86_64'}.get(platform.machine())
        system = {'Darwin': 'apple-darwin', 'Linux': 'unknown-linux-musl'}.get(platform.system())
        if not architecture or not system:
            raise RuntimeError('Supply a matching wasm-bindgen with --bindgen on this development host')
        name = f'wasm-bindgen-{version}-{architecture}-{system}'
        destination = root/'core/target/tools'
        executable = destination/name/'wasm-bindgen'
        if not executable.exists():
            destination.mkdir(parents=True, exist_ok=True)
            base = f'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/{version}/{name}.tar.gz'
            try:
                archive = download(base)
                expected = download(base+'.sha256sum').decode().split()[0]
                if hashlib.sha256(archive).hexdigest() != expected:
                    raise RuntimeError('wasm-bindgen download checksum mismatch')
                path = destination/(name+'.tar.gz')
                path.write_bytes(archive)
                with tarfile.open(path) as tar:
                    for member in tar.getmembers():
                        if member.name.startswith('/') or '..' in Path(member.name).parts or member.issym() or member.islnk():
                            raise RuntimeError('Unsafe wasm-bindgen archive member')
                    tar.extractall(destination)
            except (urllib.error.URLError, TimeoutError) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code != 429 and not 500 <= error.code < 600:
                    raise
                print(f'Release downloads unavailable; building locked wasm-bindgen {version} from crates.io', file=sys.stderr)
                # Cargo verifies registry checksums; --locked and =version prevent
                # dependency or tool upgrades. Integrity failures above stay fatal.
                subprocess.run(['cargo', f'+{toolchain}', 'install', '--locked', '--version',
                                f'={version}', '--bin', 'wasm-bindgen', '--root',
                                str(destination/name), 'wasm-bindgen-cli'], check=True)
                shutil.copy2(destination/name/'bin/wasm-bindgen', executable)
            executable.chmod(0o755)
    actual = subprocess.check_output([executable, '--version'], text=True).strip()
    if actual != f'wasm-bindgen {version}':
        raise RuntimeError(f'Expected wasm-bindgen {version}, got {actual}')
    return executable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toolchain', default='1.95.0')
    parser.add_argument('--bindgen', default=os.environ.get('KRAB_WASM_BINDGEN'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    subprocess.run(['cargo', f'+{args.toolchain}', 'build', '--locked', '--release',
                    '--manifest-path', str(root/'core/Cargo.toml'), '--target', 'wasm32-unknown-unknown'], cwd=root, check=True)
    binary = root/'core/target/wasm32-unknown-unknown/release/krab_core.wasm'
    output = root/'src/generated/engine'
    output.mkdir(parents=True, exist_ok=True)
    # Published and source-built tools have different build-commit metadata.
    # Remove that non-executable section so either verified path is reproducible.
    subprocess.run([binding_tool(root, args.bindgen, args.toolchain), '--remove-producers-section', '--target', 'web', '--out-dir', str(output),
                    '--out-name', 'engine', str(binary)], check=True)
    digest = hashlib.sha256()
    for path in source_files(root):
        digest.update(path.relative_to(root).as_posix().encode()+b'\0'+path.read_bytes())
    metadata = {
        'version': json.loads((root/'package.json').read_text())['version'],
        'sourceSha256': digest.hexdigest(),
        'wasmSha256': hashlib.sha256((output/'engine_bg.wasm').read_bytes()).hexdigest(),
        'bindingsSha256': hashlib.sha256((output/'engine.js').read_bytes()).hexdigest(),
        'rustc': subprocess.check_output(['rustc', f'+{args.toolchain}', '--version'], text=True).strip(),
    }
    (root/'src/generated/core-build.json').write_text(json.dumps(metadata, indent=2)+'\n')
    print(f'Built shared browser engine and validator: {(output/"engine_bg.wasm").stat().st_size} bytes')


if __name__ == '__main__':
    main()
