"""Verify tool integrity checks and bounded retries without network access."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

install = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/install-syft.py'))['install']


class SyftDownloads(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patch.dict(os.environ, RUNNER_TEMP=directory.name).start()
        patch('platform.system', return_value='Linux').start()
        patch('platform.machine', return_value='x86_64').start()
        self.sleep = patch('time.sleep').start()
        self.run = patch('subprocess.run', side_effect=self.download).start()
        self.version = patch('subprocess.check_output', return_value=json.dumps({'version': '1.52.0'})).start()
        self.corrupt = False
        self.symlink = False
        self.addCleanup(patch.stopall)

    def download(self, args, **kwargs):
        directory = Path(args[args.index('--dir') + 1])
        archive = directory/'syft_1.52.0_linux_amd64.tar.gz'
        with tarfile.open(archive, 'w:gz') as package:
            member = tarfile.TarInfo('syft')
            member.size = 7
            if self.symlink:
                member.type = tarfile.SYMTYPE
                member.linkname = '/another/file'
            package.addfile(member, io.BytesIO(b'fixture'))
        digest = '0' * 64 if self.corrupt else hashlib.sha256(archive.read_bytes()).hexdigest()
        (directory/'syft_1.52.0_checksums.txt').write_text(f'{digest}  {archive.name}\n')

    def test_exact_release_and_checksum_are_required_before_running_the_tool(self):
        executable = install()
        self.assertEqual(executable.read_bytes(), b'fixture')
        self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
        args = self.run.call_args.args[0]
        self.assertIn('v1.52.0', args)
        self.assertIn('anchore/syft', args)
        self.assertEqual(self.run.call_args.kwargs['timeout'], 90)

    def test_checksum_mismatch_never_executes_a_downloaded_file(self):
        self.corrupt = True
        with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            install()
        self.version.assert_not_called()

    def test_symlinks_are_rejected(self):
        self.symlink = True
        with self.assertRaisesRegex(RuntimeError, 'regular executable'):
            install()
        self.version.assert_not_called()

    def test_binary_must_report_the_pinned_version(self):
        self.version.return_value = json.dumps({'version': '2.0.0'})
        with self.assertRaisesRegex(RuntimeError, 'pinned release'):
            install()

    def test_network_failures_stay_bounded(self):
        self.run.side_effect = subprocess.CalledProcessError(1, 'gh')
        with self.assertRaises(subprocess.CalledProcessError):
            install()
        self.assertEqual(self.run.call_count, 3)
        self.assertEqual(self.sleep.call_count, 2)

    def test_nonexact_versions_are_rejected_without_downloading(self):
        with self.assertRaises(ValueError):
            install('latest')
        self.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
