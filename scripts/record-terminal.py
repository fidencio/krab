"""Capture real KRAB terminal walkthrough frames; render with render-walkthrough.mjs.

Run on a Unix host with a built CLI. No cluster credentials or network needed.
"""
import argparse
import fcntl
import os
import signal
import struct
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

PALETTE = ['#101722', '#f87171', '#83d29d', '#e7c77b', '#87b6f9', '#c8a3ec', '#7bd5d4', '#e2e8f0']


def screen(source):
    """Decode the cursor-addressed terminal and SGR styles into stable video frames."""
    import re
    cells = [[[' ', '#e2e8f0', '#0b1220', False] for _ in range(140)] for _ in range(40)]
    row = col = 0
    fg, bg, bold, reverse = '#e2e8f0', '#0b1220', False, False
    i = 0
    while i < len(source):
        ch = source[i]
        if ch == '\x1b':
            match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', source[i:])
            if match:
                params, _, op = match.groups()
                values = [int(n) if n else 0 for n in params.split(';')] if re.fullmatch(r'[0-9;]*', params) else []
                n = values[0] if values and values[0] else 1
                if op in ('H', 'f'):
                    row, col = n - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1
                elif op == 'J' and params in ('2', '3'):
                    cells = [[[' ', '#e2e8f0', '#0b1220', False] for _ in range(140)] for _ in range(40)]
                elif op == 'K' and 0 <= row < 40:
                    start, end = (0, 140) if params == '2' else (max(0, col), 140)
                    cells[row][start:end] = [[' ', fg, bg, bold] for _ in range(end-start)]
                elif op == 'A': row -= n
                elif op == 'B': row += n
                elif op == 'C': col += n
                elif op == 'D': col -= n
                elif op == 'G': col = n - 1
                elif op == 'm':
                    j = 0
                    while j < len(values):
                        v = values[j]
                        if v == 0: fg, bg, bold, reverse = '#e2e8f0', '#0b1220', False, False
                        elif v == 1: bold = True
                        elif v == 22: bold = False
                        elif v == 7: reverse = True
                        elif v == 27: reverse = False
                        elif v == 39: fg = '#e2e8f0'
                        elif v == 49: bg = '#0b1220'
                        elif 30 <= v <= 37 or 90 <= v <= 97: fg = PALETTE[v % 10]
                        elif 40 <= v <= 47 or 100 <= v <= 107: bg = PALETTE[v % 10]
                        elif v in (38, 48) and j+2 < len(values) and values[j+1] == 5:
                            index = values[j+2]
                            if 0 <= index < 8:
                                color = PALETTE[index]
                            elif 8 <= index < 16:
                                color = ['#586575', '#ff8a8a', '#a7efb8', '#ffe29a', '#a8caff', '#e0bbff', '#a0f0ee', '#ffffff'][index-8]
                            elif 16 <= index < 232:
                                index -= 16
                                levels = [0, 95, 135, 175, 215, 255]
                                color = '#%02x%02x%02x' % (levels[index//36], levels[(index//6)%6], levels[index%6])
                            elif 232 <= index < 256:
                                color = '#%02x%02x%02x' % ((8 + (index-232)*10,) * 3)
                            else:
                                color = fg if v == 38 else bg
                            if v == 38: fg = color
                            else: bg = color
                            j += 2
                        elif v in (38, 48) and j+4 < len(values) and values[j+1] == 2:
                            color = '#%02x%02x%02x' % tuple(values[j+2:j+5])
                            if v == 38: fg = color
                            else: bg = color
                            j += 4
                        j += 1
                i += len(match[0]); continue
            if i+1 < len(source) and source[i+1] in ']_P':
                endings = [n for n in (source.find('\x07', i+2), source.find('\x1b\\', i+2)) if n >= 0]
                if endings:
                    end = min(endings); i = end + (1 if source[end] == '\x07' else 2); continue
            i += 2; continue
        if ch == '\r': col = 0
        elif ch == '\n': row += 1
        elif ord(ch) >= 32:
            if 0 <= row < 40 and 0 <= col < 140:
                cells[row][col] = [ch, bg if reverse else fg, fg if reverse else bg, bold]
            col += 1
        i += 1
    return [row[:100] for row in cells[:28]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    binary = args.binary.resolve()
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    spec = importlib.util.spec_from_file_location('krab_terminal', root/'cli/tests/terminal.py')
    module = importlib.util.module_from_spec(spec)
    sys.argv = [str(root/'cli/tests/terminal.py'), str(binary)]
    spec.loader.exec_module(module)
    args.output.mkdir(parents=True, exist_ok=True)
    frames = []
    with tempfile.TemporaryDirectory(prefix='krab-tutorial-') as directory:
        session = module.Session(directory, [])
        fcntl.ioctl(session.slave, module.termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
        os.kill(session.child.pid, signal.SIGWINCH)
        session.drain()
        def capture(caption, keys='', seconds=3):
            frames.append({'caption': caption, 'keys': keys, 'seconds': seconds,
                           'cells': screen(session.transcript.decode(errors='replace'))})
        capture('Start KRAB. Choose a deployment path; Custom combines runtime choices.', 'krab', 4)
        session.key(b'\r'); capture('Select the architectures of your cluster nodes.', 'Enter', 3)
        session.key(b'\r'); capture('Choose the Kubernetes distribution used by your cluster.', 'Enter', 3)
        session.key(b'\r'); capture('The overview keeps every configuration section within reach.', 'Enter', 4)
        session.key(b'\x1bOP'); assert 'Help' in session.screen(); capture('Press F1 for contextual help on any screen.', 'F1', 4)
        session.key(b'\r')
        for _ in range(5): session.key(b'\x1b[B')
        session.key(b'\r'); capture('Open Runtimes. Arrow keys navigate; checked entries are selected.', '↓ × 5, Enter', 4)
        session.key(b' '); capture('Space toggles a runtime and updates the live configuration panel.', 'Space', 4)
        session.key(b'\r'); session.key(b'p'); capture('Preview the generated, version-pinned Helm values before saving.', 'Enter, p', 4)
        session.key(b'\x1b'); session.key(b's'); capture('Save your configuration to a file you can edit or automate later.', 'Esc, s', 3)
        session.key(b'\r'); capture('Review the destination and confirm the save.', 'Enter', 3)
        session.key(b'\r'); session.finish()
        assert (Path(directory)/'krab.yaml').exists()
    (args.output/'tui.json').write_text(json.dumps({'title':'Configure in the TUI', 'version':version, 'frames':frames}))
    frames = []
    with tempfile.TemporaryDirectory(prefix='krab-cli-tutorial-') as directory:
        transcript = ''
        commands = [
            (['init', '--non-interactive', '--output', 'krab.yaml'], 'Create a starter configuration without opening the TUI.'),
            (['validate', '--config', 'krab.yaml'], 'Validate the configuration offline before generating values.'),
            (['generate', '--config', 'krab.yaml', '--output', 'values.yaml'], 'Generate the Helm values file using the same pinned catalog as the website.'),
        ]
        for command, caption in commands:
            transcript += '$ krab ' + ' '.join(command) + '\r\n'
            result = subprocess.run([binary, *command], cwd=directory, text=True, capture_output=True, check=True)
            transcript += (result.stdout+result.stderr).replace('\n', '\r\n') + '\r\n'
            frames.append({'caption':caption,'keys':'','seconds':5,'cells':screen(transcript)})
        transcript += '$ head -n 12 values.yaml\r\n'
        preview = subprocess.check_output(['head','-n','12','values.yaml'],cwd=directory,text=True)
        transcript += preview.replace('\n','\r\n')
        frames.append({'caption':'The output includes its format, chart version, and deployment path. Review it before deploying.', 'keys':'', 'seconds':6, 'cells':screen(transcript)})
    (args.output/'cli.json').write_text(json.dumps({'title':'Generate values from the CLI', 'version':version, 'frames':frames}))
    print(f'Recorded two real {version} walkthroughs in {args.output}')


if __name__ == '__main__':
    main()
