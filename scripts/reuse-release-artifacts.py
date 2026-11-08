"""Find complete, successful main-branch build artifacts for the exact release SHA."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import time
from urllib.parse import urlencode


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True))


def matching(run, sha, workflow):
    return (run.get('head_sha') == sha and run.get('head_branch') == 'main'
            and run.get('event') == 'push'
            and run.get('path') == f'.github/workflows/{workflow}')


def find(repository, sha, workflow, expected, wait_seconds):
    deadline = time.monotonic() + wait_seconds
    query = urlencode({'branch': 'main', 'event': 'push', 'head_sha': sha, 'per_page': 20})
    while True:
        runs = api(f'repos/{repository}/actions/workflows/{workflow}/runs?{query}')['workflow_runs']
        eligible = [run for run in runs if matching(run, sha, workflow)]
        for run in eligible:
            if run.get('status') != 'completed' or run.get('conclusion') != 'success':
                continue
            artifacts = api(f'repos/{repository}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
            available = {item['name'] for item in artifacts
                         if not item.get('expired', True) and item.get('size_in_bytes', 0) > 0}
            if expected <= available:
                print(f'{workflow}: reuse verified artifacts from run {run["id"]}', flush=True)
                return str(run['id'])
        pending = any(run.get('status') in ('queued', 'in_progress', 'waiting', 'pending') for run in eligible)
        remaining = deadline - time.monotonic()
        if not pending or remaining <= 0:
            print(f'{workflow}: no complete verified set; build fresh artifacts', flush=True)
            return ''
        print(f'{workflow}: waiting for the existing build of {sha[:12]}', flush=True)
        time.sleep(min(15, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wait-seconds', type=int, default=600)
    args = parser.parse_args()
    repository = os.environ['GITHUB_REPOSITORY']
    sha = os.environ['GITHUB_SHA']
    jobs = [
        ('preflight', 'preflight-binaries.yml', {'krab-preflight-linux-amd64', 'krab-preflight-linux-arm64'}),
        ('cli', 'cli.yml', {'krab-cli-linux-amd64', 'krab-cli-linux-arm64', 'krab-cli-darwin-arm64'}),
    ]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [(name, pool.submit(find, repository, sha, workflow, expected, args.wait_seconds))
                   for name, workflow, expected in jobs]
        outputs = {name: future.result() for name, future in futures}
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        for name, run_id in outputs.items():
            output.write(f'{name}={run_id}\n')


if __name__ == '__main__':
    main()
