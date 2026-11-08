"""Exercise the actual Ratatui terminal, keyboard controls, and restoration."""
import errno
import atexit
import base64
import fcntl
import json
import os
import re
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

binary = str(Path(sys.argv[1]).resolve())

class Session:
    def __init__(self, directory, args, graphics=None, extra_env=None, background=None):
        self.background = background
        self.graphics = graphics
        self.probe_answered = False
        self.query_buffer = bytearray()
        self.cursor_queries = 0
        self.master, self.slave = os.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
        self.before = termios.tcgetattr(self.slave)
        environment = {**os.environ, 'TERM': 'xterm-256color'}
        for name in ('TERM_PROGRAM', 'LC_TERMINAL', 'TMUX'):
            environment.pop(name, None)
        if graphics == 'iterm2':
            environment['TERM_PROGRAM'] = 'iTerm.app'
        environment.update(extra_env or {})
        self.child = subprocess.Popen([binary, *args], cwd=directory, stdin=self.slave,
                                      stdout=subprocess.PIPE, stderr=self.slave,
                                      env=environment, start_new_session=True,
                                      preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        atexit.register(self.close)
        self.transcript = bytearray()
        self.drain()

    def drain(self):
        deadline = time.monotonic() + 5
        received = False
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.15)
            if readable:
                try:
                    data = os.read(self.master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                self.transcript.extend(data)
                # A real terminal answers the capability probe before input.
                self.query_buffer.extend(data)
                cursor_queries = self.query_buffer.count(b'\x1b[6n')
                if cursor_queries > self.cursor_queries:
                    os.write(self.master, b'\x1b[1;1R' * (cursor_queries - self.cursor_queries))
                    self.cursor_queries = cursor_queries
                if not self.probe_answered and b'\x1b[5n' in self.query_buffer:
                    capabilities = {
                        'iterm2': b'\x1b_Gi=31;OK\x1b\\\x1b[?64;4c\x1b[6;16;8t',
                        'iterm2-without-env': b'\x1bP>|iTerm2 3.6.0\x1b\\\x1b_Gi=31;OK\x1b\\\x1b[?64;4c\x1b[6;16;8t',
                        'kitty': b'\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t',
                        'sixel': b'\x1b[?64;4c\x1b[6;16;8t',
                    }.get(self.graphics, b'')
                    os.write(self.master, capabilities + (self.background or b'') + b'\x1b[0n')
                    self.probe_answered = True
                received = True
            elif (received and b'KRAB' in self.transcript) or self.child.poll() is not None:
                break
        assert received or self.child.poll() is not None, self.transcript.decode(errors='replace')

    def screen(self):
        # Decode cursor-addressed Ratatui updates into visible cells. Checking a
        # raw transcript misses unchanged letters omitted by buffer diffing.
        cells = [[' '] * 140 for _ in range(40)]
        row = column = 0
        source = self.transcript.decode(errors='replace')
        position = 0
        while position < len(source):
            char = source[position]
            if char == '\x1b':
                match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', source[position:])
                if match:
                    params, _, operation = match.groups()
                    numbers = [int(n) if n else 1 for n in params.split(';')] if re.fullmatch(r'[0-9;]*', params) else []
                    if operation in ('H', 'f'):
                        row = (numbers[0] if numbers else 1) - 1
                        column = (numbers[1] if len(numbers) > 1 else 1) - 1
                    elif operation == 'J' and params in ('2', '3'):
                        cells = [[' '] * 140 for _ in range(40)]
                    elif operation == 'K':
                        start, end = (0, 140) if params == '2' else (column, 140)
                        if 0 <= row < 40:
                            cells[row][max(start, 0):end] = [' '] * (end - max(start, 0))
                    elif operation == 'A': row -= numbers[0]
                    elif operation == 'B': row += numbers[0]
                    elif operation == 'C': column += numbers[0]
                    elif operation == 'D': column -= numbers[0]
                    position += len(match[0])
                    continue
                if position + 1 < len(source) and source[position + 1] in ']_P':
                    terminators = [n for n in (source.find('\x07', position + 2), source.find('\x1b\\', position + 2)) if n >= 0]
                    if terminators:
                        end = min(terminators)
                        position = end + (1 if source[end] == '\x07' else 2)
                        continue
                position += 2
                continue
            if char == '\r': column = 0
            elif char == '\n': row += 1
            elif ord(char) >= 32:
                if 0 <= row < 40 and 0 <= column < 140:
                    cells[row][column] = char
                column += 1
            position += 1
        return '\n'.join(''.join(line).rstrip() for line in cells)

    def wait_for(self, text, since=0):
        deadline = time.monotonic() + 10
        needle = re.sub(rb'\s+', b'', text)
        while time.monotonic() < deadline:
            if needle in re.sub(rb'\s+', b'', self.screen().encode()):
                return
            self.drain()
        raise AssertionError((text, self.screen()))

    def key(self, data):
        os.write(self.master, data)
        self.drain()

    def close(self):
        if self.child.poll() is None:
            self.child.kill()
            self.child.communicate()
        for name in ('master', 'slave'):
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)

    def finish(self):
        try:
            stdout, _ = self.child.communicate(timeout=10)
            assert self.child.returncode == 0, self.transcript.decode(errors='replace')
            assert b'\x1b[?1049h' in self.transcript, 'TUI did not enter alternate screen'
            assert b'\x1b[?1049l' in self.transcript, 'TUI did not restore alternate screen'
            # Darwin revokes the slave when the controlling session exits.
            assert termios.tcgetattr(self.master) == self.before, 'Terminal modes were not restored'
            return stdout
        finally:
            self.close()

def main():
    with tempfile.TemporaryDirectory(prefix='krab-terminal-') as directory:
        # Bare krab starts setup, then saves from the overview.
        session = Session(directory, [])
        assert b'KRAB' in session.transcript and b'configuration' in session.transcript, repr(session.transcript)
        for _ in range(3):
            session.key(b'\r')
        session.key(b's')
        session.key(b'\r')
        session.key(b'\r')
        assert not session.finish()
        path = Path(directory) / 'krab.yaml'
        assert path.exists()

        # Bare krab reopens the file. A runtime checkbox toggles without Enter.
        session = Session(directory, [])
        session.key(b'?')
        assert b'Help' in session.transcript
        session.key(b'\r')  # Close help without opening the highlighted section.
        for _ in range(5):
            session.key(b'\x1b[B')
        session.key(b'\r')
        session.key(b' ')
        assert b'clh-runtime-rs' in session.transcript
        session.key(b'?')
        session.key(b'\x1b')  # Resume the checkbox draft without rolling it back.
        session.key(b'\r')
        session.key(b's')
        session.key(b'\r')
        session.key(b'\r')
        assert not session.finish()
        values = subprocess.run([binary, 'generate', '--config', str(path), '--json'],
                                capture_output=True, text=True, check=True)
        assert json.loads(values.stdout)['kata-deploy']['shims']['clh-runtime-rs']['enabled']

        # Changing a value and declining exit keeps editing; confirmed discard preserves the file.
        original = path.read_bytes()
        session = Session(directory, [])
        for _ in range(4):
            session.key(b'\x1b[B')
        session.key(b'\r')
        session.key(b'\x1b[B')
        session.key(b'\r')
        session.key(b'q')
        session.key(b'n')
        session.key(b'q')
        session.key(b'y')
        assert not session.finish()
        assert path.read_bytes() == original

        # UI rendering stays on stderr, including when the edited YAML goes to stdout.
        session = Session(directory, ['edit', '--output', '-'])
        session.key(b's')
        session.key(b'\r')
        session.key(b'\r')
        source = session.finish()
        assert b'\x1b' not in source
        verdict = subprocess.run([binary, 'validate', '--config', '-', '--json'], input=source,
                                 capture_output=True, check=True)
        assert json.loads(verdict.stdout)['valid']

        # Graphics-capable terminals get the actual image in the header; UI and
        # capability probes still leave stdout clean and terminal modes restored.
        for graphics in ('iterm2', 'iterm2-without-env', 'kitty', 'sixel'):
            session = Session(directory, ['edit', '--output', '-'], graphics=graphics)
            transcript = bytes(session.transcript)
            if graphics.startswith('iterm2'):
                match = re.search(rb'\x1b\]1337;File=[^:]+:([^\x07]+)\x07', transcript)
                assert match, ('Missing iTerm2 image payload', transcript)
                assert b'a=T,U=1,f=32,' not in transcript, 'iTerm2 must use its native image protocol'
                parameters = match[0].split(b':', 1)[0]
                assert b';width=6;height=3;' in parameters, 'Logo must use cell units on Retina displays'
                filename = re.search(rb';name=([^;]+);', parameters)
                assert filename and base64.b64decode(filename[1]) == b'krab-logo.png'
                png = base64.b64decode(match[1])
                assert png.startswith(b'\x89PNG\r\n\x1a\n')
                assert struct.unpack('>II', png[16:24]) == (48, 48)
            elif graphics == 'kitty':
                assert b'a=T,U=1,f=32,' in transcript, 'Missing Kitty image payload'
            else:
                assert re.search(rb'\x1bP[^q]*q', transcript), 'Missing Sixel image payload'
            session.key(b'?')
            session.key(b'\r')
            session.key(b's')
            session.key(b'\r')
            session.key(b'\r')
            source = session.finish()
            assert b'\x1b' not in source
            assert b'apiVersion:' in source
    # Product themes work with terminal background replies even without graphics
    # or a font-size response; explicit mode overrides win over that reply.
    for requested, background, page in (
        ('auto', b'\x1b]11;rgb:ffff/ffff/ffff\x07', b'48;2;244;248;252'),
        ('auto', b'\x1b]11;rgb:0000/0000/0000\x07', b'48;2;9;24;39'),
        ('dark', b'\x1b]11;rgb:ffff/ffff/ffff\x07', b'48;2;9;24;39'),
    ):
        with tempfile.TemporaryDirectory(prefix='krab-theme-terminal-') as directory:
            profile = Path(directory) / 'profile.json'
            source = json.loads((Path(__file__).resolve().parents[2] / 'demo/confidential-containers/krab-profile.json').read_text())
            source['logo'] = str(Path(__file__).resolve().parents[2] / 'demo/confidential-containers/product-logo.png')
            profile.write_text(json.dumps(source))
            subprocess.run([binary, '--profile', str(profile), 'init', '--non-interactive'], cwd=directory, check=True, capture_output=True)
            session = Session(directory, ['--profile', str(profile), 'edit'],
                              extra_env={'KRAB_THEME': requested}, background=background, graphics='iterm2-without-env')
            assert page in session.transcript, session.transcript
            assert b'Confidential Containers' in session.transcript
            assert b'\x1b]1337;File=' in session.transcript, 'Missing CoCo profile icon'
            session.key(b'q')
            assert not session.finish()
    print('Product palettes, terminal background detection, and mode overrides passed.')
    print('Ratatui keyboard input, live selections, bare command routing, save/discard, stdout, and terminal restoration passed.')

if __name__ == "__main__":
    main()
