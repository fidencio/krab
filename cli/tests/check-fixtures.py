"""Compare a Linux binary with fixtures prepared by scripts/check-cli-parity.ts.

For development on hosts without Rust; CI runs the TypeScript checker directly.
"""
import json
import subprocess
import sys

with open(sys.argv[2], encoding="utf-8") as source:
    fixtures = json.load(source)
for fixture in fixtures:
    result = subprocess.run(
        [sys.argv[1], "generate", "--config", "-", "--json"],
        input=fixture["input"], text=True, capture_output=True, check=False,
    )
    if result.returncode:
        sys.exit(f'{fixture["context"]}: {result.stderr}')
    actual = json.loads(result.stdout)
    if actual != fixture["expected"]:
        print(fixture["context"], file=sys.stderr)
        print(json.dumps({"actual": actual, "expected": fixture["expected"]}, indent=2), file=sys.stderr)
        sys.exit(1)
print(f'CLI/web values parity passed for {len(fixtures)} configurations.')
