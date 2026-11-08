"""Smoke KRAB runtime classes after Kata's own scripts bootstrap Kubernetes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


RUNTIMES = ['qemu-runtime-rs', 'clh-runtime-rs', 'dragonball',
            'qemu-coco-dev-runtime-rs', 'qemu-nvidia-cpu-runtime-rs']
NODE_IMAGE = 'docker.io/krab-ci/preflight:smoke'


def command(*args, input=None, check=True):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(map(str, args))}\n{result.stdout}\n{result.stderr}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', required=True,
                        choices=['kubeadm', 'k0s', 'k3s', 'microk8s', 'rke2'])
    args = parser.parse_args()
    binary = str(Path('smoke-tools/krab').resolve())
    output = Path('smoke-results')
    output.mkdir(exist_ok=True)
    catalog = json.loads(command(binary, 'list', 'catalog', '--json').stdout)
    vendor = next(v for v in catalog['vendors'] if v['id'] == 'custom')
    shims = {shim['id']: shim for shim in vendor['runtime']['shims']}
    for runtime in RUNTIMES:
        assert 'amd64' in shims[runtime]['supportedArches'], runtime
    distribution = next(d for d in catalog['plannedArchitecture']['cluster']['distributions']
                        if d['id'] == args.distribution)
    nodes = json.loads(command('kubectl', 'get', 'nodes', '-o', 'json').stdout)
    assert len(nodes['items']) == 1, 'Smoke tests expect the upstream single-node cluster'
    node = nodes['items'][0]['metadata']['name']
    configz = json.loads(command('kubectl', 'get', '--raw', f'/api/v1/nodes/{node}/proxy/configz').stdout)
    endpoint = configz['kubeletconfig']['containerRuntimeEndpoint']
    # Kubelet accepts both a unix:// URL and a bare absolute socket path.
    socket = endpoint.removeprefix('unix://')
    assert socket.startswith('/'), endpoint
    command('sudo', 'ctr', '--address', socket, '--namespace', 'k8s.io',
            'images', 'import', str(Path('smoke-tools/preflight.tar').resolve()))
    results = []

    def deploy(runtimes, stage):
        config = {'apiVersion': 'krab/v1alpha1', 'vendor': 'custom',
                  'distribution': args.distribution, 'architectures': ['amd64'],
                  'release': 'krab-smoke', 'namespace': 'kata-system', 'runtimes': runtimes,
                  'runtime': {'installErofsUtils': any(shims[r]['snapshotter'] == 'erofs' for r in runtimes)},
                  'valuesOverrides': {'global': {'krab': {'nodeImage': NODE_IMAGE}}}}
        configuration = output / f'{stage}.config.json'
        configuration.write_text(json.dumps(config, indent=2) + '\n')
        generated = command(binary, 'generate', '--config', str(configuration), '--json', check=False)
        if generated.returncode:
            reason = distribution.get('unsupportedSnapshotters', {}).get('erofs')
            if stage == 'erofs' and reason and generated.returncode == 2 and reason in generated.stderr:
                results.append({'runtime': RUNTIMES[-1], 'status': 'blocked', 'reason': reason})
                return False
            raise RuntimeError(generated.stderr)
        values = output / f'{stage}.values.json'
        values.write_text(generated.stdout)
        rendered = command('helm', 'template', 'krab-smoke', 'charts/krab', '--namespace',
                           'kata-system', '--values', str(values)).stdout
        (output / f'{stage}.rendered.yaml').write_text(rendered)
        deployed = command('helm', 'upgrade', '--install', 'krab-smoke', 'charts/krab',
                           '--namespace', 'kata-system', '--create-namespace', '--wait',
                           '--timeout', '12m', '--values', str(values), check=False)
        (output / f'{stage}.helm.log').write_text(deployed.stdout + deployed.stderr)
        if deployed.returncode:
            raise RuntimeError(deployed.stdout + deployed.stderr)
        return True

    def smoke(runtime):
        print(f'::group::Smoke {runtime}', flush=True)
        name = 'smoke-' + runtime
        pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': 'kata-system'},
               'spec': {'runtimeClassName': 'kata-' + runtime, 'restartPolicy': 'Never',
                        'tolerations': [{'operator': 'Exists'}],
                        'containers': [{'name': 'smoke',
                                        'image': 'quay.io/kata-containers/alpine-bash-curl:latest',
                                        'command': ['sh', '-ec', 'echo KRAB_SMOKE_OK; uname -r; cat /proc/sys/kernel/random/boot_id'],
                                        'resources': {'requests': {'cpu': '10m', 'memory': '32Mi'}}}]}}
        command('kubectl', 'apply', '-f', '-', input=json.dumps(pod))
        waited = command('kubectl', '-n', 'kata-system', 'wait', '--for=jsonpath={.status.phase}=Succeeded',
                         f'pod/{name}', '--timeout=240s', check=False)
        log = command('kubectl', '-n', 'kata-system', 'logs', name, check=False).stdout
        (output / f'{runtime}.log').write_text(log)
        (output / f'{runtime}.pod.json').write_text(
            command('kubectl', '-n', 'kata-system', 'get', 'pod', name, '-o', 'json').stdout)
        assert waited.returncode == 0, waited.stderr + log
        assert 'KRAB_SMOKE_OK' in log, log
        host_boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        assert log.strip().splitlines()[-1] != host_boot, 'Pod ran on the host kernel instead of a Kata VM'
        command('kubectl', '-n', 'kata-system', 'delete', 'pod', name, '--wait=true', '--timeout=60s')
        print(log, flush=True)
        print('::endgroup::', flush=True)
        results.append({'runtime': runtime, 'status': 'pass'})

    try:
        deploy(RUNTIMES[:-1], 'default-and-nydus')
        for runtime in RUNTIMES[:-1]:
            smoke(runtime)
        if deploy(RUNTIMES, 'erofs'):
            smoke(RUNTIMES[-1])
    finally:
        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f'### {args.distribution}\n\n| Runtime | Result |\n| --- | --- |\n')
                for result in results:
                    summary.write(f"| {result['runtime']} | {result['status']} |\n")


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, RuntimeError, KeyError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
