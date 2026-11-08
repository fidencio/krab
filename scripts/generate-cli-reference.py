"""Generate the on-site command reference from the real CLI's help output."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
binary = args.binary.resolve()
version = json.loads((root/'package.json').read_text())['version']
actual = subprocess.check_output([binary, '--version'], text=True).strip()
if actual != f'krab {version}':
    parser.error(f'CLI {actual!r} must match website {version}')

def help_text(*command):
    return subprocess.check_output([binary, *command, '--help'], text=True, env={**os.environ, 'COLUMNS': '80', 'NO_COLOR': '1', 'TERM': 'dumb'}).strip()

help_output = help_text()
command_block = help_output.split('Commands:\n', 1)[1].split('\nOptions:', 1)[0]
commands = []
for line in command_block.splitlines():
    match = re.match(r'^  ([a-z][a-z-]*)\s{2,}(.*)$', line)
    if match and match[1] != 'help':
        commands.append({'name': match[1], 'about': match[2], 'help': help_text(match[1])})
result = json.dumps({'version': version, 'help': help_output, 'commands': commands}, indent=2)+'\n'
output = root/'src/generated/cli-reference.json'
if args.check:
    if not output.exists() or output.read_text() != result:
        parser.exit(1, 'CLI reference is stale; run scripts/generate-cli-reference.py with the built matching binary\n')
    print(f'CLI documentation matches {len(commands)} actual command help pages')
else:
    output.write_text(result)
    print(f'Generated {len(commands)} command help pages')
