"""Install pinned Syft through the GitHub release API and verify its checksum."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tarfile
import tempfile
import time


def install(version='1.52.0'):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Syft version must be an exact release version')
    system = {'Linux': 'linux', 'Darwin': 'darwin'}.get(platform.system())
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if not system or not arch:
        raise RuntimeError('Unsupported Syft build host')
    directory = Path(tempfile.mkdtemp(prefix='krab-syft-', dir=os.environ['RUNNER_TEMP']))
    archive = f'syft_{version}_{system}_{arch}.tar.gz'
    checksums = f'syft_{version}_checksums.txt'
    for attempt in range(3):
        try:
            subprocess.run([
                'gh', 'release', 'download', f'v{version}', '--repo', 'anchore/syft',
                '--pattern', archive, '--pattern', checksums, '--dir', str(directory), '--clobber',
            ], check=True, timeout=90)
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    matches = [parts[0] for line in (directory/checksums).read_text().splitlines()
               if len(parts := line.split()) == 2 and parts[1].lstrip('*') == archive]
    if len(matches) != 1 or not re.fullmatch('[0-9a-fA-F]{64}', matches[0]):
        raise RuntimeError('Missing or ambiguous Syft archive checksum')
    if hashlib.sha256((directory/archive).read_bytes()).hexdigest() != matches[0].lower():
        raise RuntimeError('Syft archive checksum mismatch')
    executable = directory/'syft'
    with tarfile.open(directory/archive) as package:
        member = package.getmember('syft')
        if not member.isfile():
            raise RuntimeError('Syft archive must contain a regular executable')
        with package.extractfile(member) as source:
            executable.write_bytes(source.read())
    executable.chmod(0o755)
    actual = json.loads(subprocess.check_output([executable, 'version', '-o', 'json'], text=True))
    if actual['version'].removeprefix('v') != version:
        raise RuntimeError('Installed Syft version does not match the pinned release')
    return executable


if __name__ == '__main__':
    executable = install()
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'cmd={executable}\n')
    print(f'Installed checksum-verified Syft: {executable}')
