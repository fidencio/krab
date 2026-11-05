"""Prepare and verify a host-daemon reboot test; never reboots the host itself."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['setup', 'verify', 'observe', 'cleanup'])
parser.add_argument('--expected-hostname', required=True)
parser.add_argument('--checker', type=Path)
args = parser.parse_args()
if os.geteuid() != 0 or os.uname().nodename != args.expected_hostname:
    parser.error('requires root on the explicitly named test VM')
state_dir = Path('/var/lib/krab-conformance-reboot-test')
state_file = state_dir / 'state.json'
report_file = state_dir / 'report.json'
unit = 'krab-conformance.service'
bin_dir = Path('/opt/krab/conformance')
feature = Path('/run/krab/features/conformance')
marker = feature.parent / 'previous-boot-marker'
evidence = Path('/var/lib/krab/conformance/latest.json')
unit_file = Path('/etc/systemd/system') / unit
manifest = Path('/etc/krab/conformance.sha256')
link = Path('/etc/kubernetes/node-feature-discovery/features.d/krab-conformance')

def run(command, check=True):
    return subprocess.run(command, check=check, capture_output=True, text=True)

def ctl(*command, check=True):
    return run(['systemctl', *command], check=check).stdout.strip()

def prop(key):
    return ctl('show', unit, '--property=' + key, '--value')

def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def latest():
    return json.loads(evidence.read_text())

def wait_result(expected_boot, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            data = latest()
            if data['precheck']['node']['bootID'] == expected_boot and feature.is_file():
                return data
        except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError):
            pass
        time.sleep(.2)
    raise AssertionError('no current-boot result\n' + ctl('status', unit, '--no-pager', check=False))

def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')

if args.phase == 'setup':
    if args.checker is None:
        parser.error('setup requires --checker')
    owned_paths = [unit_file, bin_dir, evidence.parent,
        Path('/var/lib/private/krab/conformance'), manifest, link,
        Path('/etc/systemd/system/multi-user.target.wants') / unit]
    if state_dir.exists() or any(path.exists() or path.is_symlink() for path in owned_paths):
        parser.error('refusing to replace pre-existing conformance integration or test state')
    state_dir.mkdir(mode=0o700)
    state = {'test': 'krab-conformance-reboot', 'old_boot_id': boot_id(),
        'checker_sha256': hashlib.sha256(args.checker.read_bytes()).hexdigest(), 'setup_at': int(time.time())}
    save(state_file, state)
    run([str(args.checker), 'conformance', 'install', '--checker', str(args.checker),
        '--checker-sha256', state['checker_sha256'], '--require', 'kvm'])
    before = wait_result(state['old_boot_id'])
    if before['verdict'] != 'pass':
        raise AssertionError('baseline node must pass before a reboot comparison')
    state['before'] = before
    state['old_pid'] = prop('MainPID')
    state['kernel_before'] = os.uname().release
    marker.write_text(state['old_boot_id'] + '\n')
    save(state_file, state)
    print(json.dumps({'phase':'prepared', 'enabled':ctl('is-enabled', unit), 'active':ctl('is-active', unit),
        'before_verdict':before['verdict'], 'old_boot_id':state['old_boot_id']}, indent=2))
else:
    state = json.loads(state_file.read_text())
    if state.get('test') != 'krab-conformance-reboot':
        parser.error('not this test\'s state')
    if args.phase == 'verify':
        current = boot_id()
        if current == state['old_boot_id']:
            raise AssertionError('the VM has not rebooted')
        after = wait_result(current)
        assert ctl('is-enabled', unit) == 'enabled'
        assert ctl('is-active', unit) == 'active'
        assert not marker.exists(), 'previous-boot runtime evidence survived'
        assert after['verdict'] == state['before']['verdict'] == 'pass'
        host = after['precheck']['node']
        assert host['machineID'] == state['before']['precheck']['node']['machineID']
        boot_epoch = int(next(line.split()[1] for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime ')))
        assert host['checkedAtUnixSeconds'] >= boot_epoch
        pid = prop('MainPID')
        uid = int(next(line.split()[1] for line in Path('/proc', pid, 'status').read_text().splitlines() if line.startswith('Uid:')))
        assert uid != 0
        assert sorted(path.name for path in bin_dir.iterdir()) == ['krab-preflight']
        assert hashlib.sha256((bin_dir / 'krab-preflight').read_bytes()).hexdigest() == state['checker_sha256']
        text = feature.read_text()
        assert 'krab.conformance.state=pass\n' in text
        expires = datetime.datetime.fromisoformat(text.splitlines()[0].split('=',1)[1])
        assert expires > datetime.datetime.now(datetime.timezone.utc)
        journal = run(['journalctl', '-b', '-u', unit, '-o', 'json', '--no-pager']).stdout
        outcomes = []
        for line in journal.splitlines():
            row = json.loads(line)
            match = re.search(r'Local conformance: (pass|fail|error)', row.get('MESSAGE',''))
            if match:
                outcomes.append({'verdict':match.group(1), 'seconds_after_boot':int(row['__MONOTONIC_TIMESTAMP']) / 1_000_000})
        assert outcomes and outcomes[0]['verdict'] == 'pass', 'first boot check was not PASS'
        assert prop('NRestarts') == '0', 'unexpected service restart during boot'
        report = {'old_boot_id':state['old_boot_id'], 'new_boot_id':current, 'automatic_start':True,
            'enabled':True, 'active':True, 'non_root_uid':uid, 'fresh_current_boot_evidence':True,
            'volatile_old_evidence_removed':True, 'checker_unchanged':True, 'checker_only_installed':True,
            'before_verdict':'pass', 'after_verdict':'pass', 'first_boot_outcome':outcomes[0],
            'restart_count':0, 'kernel_before':state['kernel_before'], 'kernel_after':os.uname().release,
            'checked_at':host['checkedAtUnixSeconds']}
        save(report_file, report)
        print(json.dumps(report, indent=2))
    elif args.phase == 'observe':
        report = json.loads(report_file.read_text())
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            data = latest()
            if data['precheck']['node']['checkedAtUnixSeconds'] > report['checked_at']:
                assert data['precheck']['node']['bootID'] == report['new_boot_id']
                assert data['verdict'] == 'pass'
                report['continued_checks_after_reboot'] = True
                report['next_check_delta_seconds'] = data['precheck']['node']['checkedAtUnixSeconds'] - report['checked_at']
                assert 58 <= report['next_check_delta_seconds'] <= 65
                save(report_file, report)
                print(json.dumps(report, indent=2))
                break
            time.sleep(1)
        else:
            raise AssertionError('no next scheduled check after reboot')
    elif args.phase == 'cleanup':
        run([str(bin_dir / 'krab-preflight'), 'conformance', 'remove'])
        assert not unit_file.exists() and not feature.exists()
        assert not (bin_dir / 'krab-preflight').exists()
        assert evidence.exists(), 'uninstall must preserve diagnostic evidence'
        for path in [bin_dir, evidence.parent, Path('/var/lib/private/krab/conformance'),
                     feature.parent, Path('/run/private/krab/features')]:
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
        shutil.rmtree(state_dir)
        print('Reboot test integration removed; no conformance daemon left enabled')
