"""Build the release CLI with all local packages under one Cargo workspace root.

Cargo hashes path dependencies relative to the workspace. Standalone cli/ puts
its sibling crates outside that root, so identical checkouts at different paths
produce different crate metadata even with --remap-path-prefix. An isolated,
virtual workspace normalizes those package identities without changing the
independent development manifests or their lockfiles.
"""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--toolchain', default='1.95.0')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='krab-release-') as temporary:
        workspace = Path(temporary)
        for name in ['cli', 'core', 'preflight', 'src', 'charts', 'upstream']:
            shutil.copytree(root / name, workspace / name,
                            ignore=shutil.ignore_patterns('target', 'cache', 'node_modules', 'engine', 'core-build.json'))
        (workspace / 'Cargo.toml').write_text(
            '[workspace]\nmembers = ["cli"]\nexclude = ["core", "preflight"]\nresolver = "2"\n')
        shutil.copyfile(root / 'cli/Cargo.lock', workspace / 'Cargo.lock')
        environment = os.environ.copy()
        flags = (environment.get('CARGO_ENCODED_RUSTFLAGS', '').split('\x1f')
                 if environment.get('CARGO_ENCODED_RUSTFLAGS') else shlex.split(environment.get('RUSTFLAGS', '')))
        cargo_home = Path(environment.get('CARGO_HOME', Path.home() / '.cargo')).resolve()
        flags.extend([f'--remap-path-prefix={workspace}=/usr/src/krab',
                      f'--remap-path-prefix={root}=/usr/src/krab',
                      f'--remap-path-prefix={cargo_home}=/usr/src/cargo'])
        environment.pop('RUSTFLAGS', None)
        environment['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
        environment['CARGO_TARGET_DIR'] = str(root / 'cli/target')
        environment['CARGO_INCREMENTAL'] = '0'
        subprocess.run(['cargo', f'+{args.toolchain}', 'build', '--locked', '--release',
                        '--manifest-path', str(workspace / 'Cargo.toml'), '--package', 'krab',
                        '--target', args.target], env=environment, check=True)


if __name__ == '__main__':
    main()
