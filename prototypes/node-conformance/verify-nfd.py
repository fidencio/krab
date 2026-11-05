"""Manual integration test; accepts only an explicitly labelled disposable container."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--checker', type=Path, required=True)
parser.add_argument('--features-dir', type=Path, required=True)
parser.add_argument('--result-dir', type=Path, required=True)
parser.add_argument('--container', default='krab-conformance-nfd')
parser.add_argument('--node', default='conformance-test')
parser.add_argument('--rule-name', default='conformance-test-node-feature-discovery-node-conformance')
parser.add_argument('--rule-file', default='/test-nfd/deployment/overlays/conformance-test/rule.yaml')
args = parser.parse_args()
info = json.loads(subprocess.run(['docker', 'inspect', args.container], check=True, capture_output=True, text=True).stdout)[0]
if (info['Config'].get('Labels') or {}).get('org.krab.test') != 'node-conformance':
    parser.error('not a disposable conformance test container')
for directory, target in [(args.features_dir, '/etc/kubernetes/node-feature-discovery/features.d'), (args.result_dir, '/run/krab/features')]:
    if not any(mount['Destination'] == target and Path(mount['Source']).resolve() == directory.resolve() for mount in info['Mounts']):
        parser.error('test directory must be a container mount')

def kube(*command):
    return subprocess.run(['docker', 'exec', args.container, 'kubectl', *command], check=True, capture_output=True, text=True).stdout

def label():
    return json.loads(kube('get', 'node', args.node, '-o', 'json'))['metadata']['labels'].get('feature.node.kubernetes.io/krab-conformance')

def eventually(expected, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if label() == expected:
            return
        time.sleep(.2)
    raise AssertionError(f'expected label {expected!r}, got {label()!r}')

kube('-n', 'node-feature-discovery', 'rollout', 'status', 'deployment/nfd-master', '--timeout=45s')
kube('-n', 'node-feature-discovery', 'rollout', 'status', 'daemonset/nfd-worker', '--timeout=45s')
feature = args.result_dir / 'conformance'
link = args.features_dir / 'krab-conformance-test'
moved = args.result_dir.with_name(args.result_dir.name + '-migrated')
if feature.exists() or link.exists() or link.is_symlink() or moved.exists():
    parser.error('refusing to replace pre-existing test files')
link.symlink_to('/run/krab/features/conformance')
results = {}
try:
    with tempfile.TemporaryDirectory(prefix='krab-nfd-host-') as directory:
        root = Path(directory)
        for folder in ['etc', 'dev', 'proc/sys/kernel/random', 'sys/devices', 'sys/bus/pci/devices']:
            (root / folder).mkdir(parents=True, exist_ok=True)
        for name, content in {'etc/machine-id':'machine-test', 'proc/sys/kernel/random/boot_id':'boot-test', 'proc/sys/kernel/osrelease':'test-kernel', 'proc/cpuinfo':'fixture'}.items():
            (root / name).write_text(content)
        (root / 'dev/kvm').symlink_to('/dev/null')
        def publish(expected, ttl=30):
            env = os.environ.copy()
            env['KRAB_PREFLIGHT_HOST_ROOT'] = str(root)
            env['KRAB_PROVISIONER'] = str(root / 'absent-provisioner')
            output = subprocess.run([str(args.checker), 'conformance', '--local', '--require', 'kvm', '--json', '--nfd-output', str(feature), '--result-ttl-seconds', str(ttl)], env=env, capture_output=True, text=True)
            assert output.returncode == {'pass':0, 'fail':1, 'error':2}[expected], output.stderr
            assert json.loads(output.stdout)['verdict'] == expected
            eventually(expected)
        publish('pass')
        results['pass_label'] = True
        (root / 'dev/kvm').unlink()
        publish('fail')
        results['fail_label'] = True
        (root / 'etc/machine-id').unlink()
        publish('error')
        results['error_label'] = True
        (root / 'etc/machine-id').write_text('machine-test')
        (root / 'dev/kvm').symlink_to('/dev/null')
        publish('pass', ttl=5)
        eventually(None, seconds=12)
        results['expiry_withdraws_label'] = True
        publish('pass')
        kube('delete', 'nodefeaturerule', args.rule_name)
        eventually(None)
        results['disabled_policy_withdraws_label'] = True
        kube('apply', '-f', args.rule_file)
        eventually('pass')
        results['reenabled_policy_relabels'] = True
        inode = args.result_dir.stat().st_ino
        args.result_dir.rename(moved)
        args.result_dir.symlink_to(moved, target_is_directory=True)
        assert args.result_dir.stat().st_ino == inode
        (root / 'dev/kvm').unlink()
        publish('fail')
        results['directory_migration_preserves_mount'] = True
        feature.unlink()
        kube('-n', 'node-feature-discovery', 'rollout', 'restart', 'daemonset/nfd-worker')
        kube('-n', 'node-feature-discovery', 'rollout', 'status', 'daemonset/nfd-worker', '--timeout=45s')
        eventually(None)
        results['worker_restart_without_result_withdraws_label'] = True
    print(json.dumps(results, indent=2))
finally:
    feature.unlink(missing_ok=True)
    link.unlink(missing_ok=True)
    if args.result_dir.is_symlink():
        args.result_dir.unlink()
        moved.rename(args.result_dir)
