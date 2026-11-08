"""Package the PR chart and render examples with the PR's native configuration engine."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', default='dist-deployments')
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    binary = str(Path(args.binary).resolve())
    catalog = json.loads(run(binary, 'list', 'catalog', '--json'))
    distributions = catalog['plannedArchitecture']['cluster']['distributions']
    vendor = next(v for v in catalog['vendors'] if v['id'] == 'custom')
    runtimes = ['qemu-runtime-rs', 'clh-runtime-rs', 'dragonball',
                'qemu-coco-dev-runtime-rs', 'qemu-nvidia-cpu-runtime-rs']
    shims = {s['id']: s for s in vendor['runtime']['shims']}
    run('helm', 'dependency', 'build', 'charts/krab')
    run('helm', 'package', 'charts/krab', '--destination', str(output))
    examples = []
    for distribution in distributions:
        for runtime in runtimes:
            snapshotter = shims[runtime].get('snapshotter')
            blocked = distribution.get('unsupportedSnapshotters', {}).get(snapshotter)
            if blocked:
                examples.append({'distribution': distribution['id'], 'runtime': runtime, 'blocked': blocked})
                continue
            destination = output / distribution['id'] / runtime
            destination.mkdir(parents=True, exist_ok=True)
            config = {'apiVersion': 'krab/v1alpha1', 'vendor': 'custom',
                      'distribution': distribution['id'], 'architectures': ['amd64'],
                      'release': 'krab-preview', 'namespace': 'kata-system', 'runtimes': [runtime],
                      'runtime': {'installErofsUtils': snapshotter == 'erofs'}}
            config_file = destination / 'krab.json'
            config_file.write_text(json.dumps(config, indent=2) + '\n')
            values = destination / 'values.yaml'
            values.write_text(run(binary, 'generate', '--config', str(config_file)))
            rendered = run('helm', 'template', 'krab-preview', 'charts/krab', '--namespace',
                           'kata-system', '--values', str(values))
            (destination / 'deployment.yaml').write_text(rendered)
            examples.append({'distribution': distribution['id'], 'runtime': runtime,
                             'path': str(destination.relative_to(output))})
    (output / 'BUILD-INFO.json').write_text(json.dumps({
        'revision': args.revision, 'version': run(binary, '--version').strip(),
        'examples': examples}, indent=2) + '\n')
    (output / 'README.txt').write_text(
        'PR deployment examples\n\nRevision: ' + args.revision + '\n\n'
        'Each example contains a native KRAB configuration, generated Helm values, and\n'
        'rendered Kubernetes manifests. These are rendered examples, not proof that a\n'
        'runtime booted: see the Kubernetes runtime smoke tests for that evidence.\n\n'
        'Review values for your nodes before installing the included chart:\n'
        'helm upgrade --install krab-preview ./krab-*.tgz --namespace kata-system '
        '--create-namespace --values <distribution>/<runtime>/values.yaml\n\n'
        'Native CLI archives are available in the Native CLI workflow artifacts.\n'
        'PR examples use the chart\'s pinned published node images; they do not publish\n'
        'or substitute a PR node-helper image.\n')
    checksums = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output)}'
                 for p in sorted(output.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS']
    (output / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
    print(f'Packaged chart and {sum("path" in e for e in examples)} rendered examples at {args.revision}')


if __name__ == '__main__':
    main()
