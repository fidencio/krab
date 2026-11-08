"""Fault-inject release download failures without making network requests."""
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

build = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/build-core.py'))
download = build['download']
asset = 'wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz'
url = f'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/{asset}'


def metadata(name=asset):
    return io.BytesIO(json.dumps({'assets': [{'name': name, 'id': 123}]}).encode())


class Downloads(unittest.TestCase):
    def setUp(self):
        self.sleep = patch('time.sleep').start()
        patch('sys.stderr', new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def test_success_does_not_need_the_api(self):
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'archive')) as request:
            self.assertEqual(download(url), b'archive')
        self.assertEqual(request.call_count, 1)
        self.sleep.assert_not_called()

    def test_transient_failure_uses_the_exact_asset_through_the_public_api(self):
        with patch('urllib.request.urlopen', side_effect=[TimeoutError(), metadata(), io.BytesIO(b'archive')]) as request:
            self.assertEqual(download(url), b'archive')
        requests = [call.args[0] for call in request.call_args_list]
        self.assertIn('/releases/tags/0.2.129?krab_retry=', requests[1].full_url)
        self.assertIn('/releases/assets/123?krab_retry=', requests[2].full_url)
        self.assertEqual(requests[2].get_header('Accept'), 'application/octet-stream')
        self.assertTrue(all(call.kwargs['timeout'] == 30 for call in request.call_args_list))

    def test_checksum_file_has_its_own_matching_api_asset(self):
        with patch('urllib.request.urlopen', side_effect=[TimeoutError(), metadata(asset + '.sha256sum'), io.BytesIO(b'checksum')]):
            self.assertEqual(download(url + '.sha256sum'), b'checksum')

    def test_permanent_http_failure_is_not_retried(self):
        with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError(url, 404, 'missing', {}, None)) as request:
            with self.assertRaises(urllib.error.HTTPError):
                download(url)
        self.assertEqual(request.call_count, 1)
        self.sleep.assert_not_called()

    def test_missing_locked_asset_fails_instead_of_using_another_build(self):
        with patch('urllib.request.urlopen', side_effect=[TimeoutError(), metadata('another-build')]):
            with self.assertRaisesRegex(RuntimeError, 'Locked wasm-bindgen release asset is missing'):
                download(url)

    def test_repeated_failure_stays_bounded_and_reuses_api_metadata(self):
        with patch('urllib.request.urlopen', side_effect=[TimeoutError(), metadata(), TimeoutError(), TimeoutError()]) as request:
            with self.assertRaises(TimeoutError):
                download(url)
        self.assertEqual(request.call_count, 4)
        self.assertEqual(self.sleep.call_count, 2)


class SourceFallback(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root/'core').mkdir()
        (self.root/'core/Cargo.lock').write_text('name = "wasm-bindgen"\nversion = "0.2.129"\n')
        patch('platform.machine', return_value='x86_64').start()
        patch('platform.system', return_value='Linux').start()
        patch('shutil.which', return_value=None).start()
        patch('sys.stderr', new_callable=io.StringIO).start()
        self.addCleanup(patch.stopall)

    def test_network_outage_uses_exact_tool_and_locked_registry_dependencies(self):
        def cargo(args, **kwargs):
            root = Path(args[args.index('--root') + 1])
            (root/'bin').mkdir(parents=True)
            (root/'bin/wasm-bindgen').write_text('source-built executable')
        with patch.dict(build['binding_tool'].__globals__, download=lambda _: (_ for _ in ()).throw(TimeoutError())), \
             patch('subprocess.run', side_effect=cargo) as install, \
             patch('subprocess.check_output', return_value='wasm-bindgen 0.2.129\n'):
            executable = build['binding_tool'](self.root, None, '1.95.0')
        args = install.call_args.args[0]
        self.assertIn('+1.95.0', args)
        self.assertIn('--locked', args)
        self.assertEqual(args[args.index('--version') + 1], '=0.2.129')
        self.assertEqual(executable.read_text(), 'source-built executable')

    def test_checksum_failure_never_falls_back_or_executes_an_archive(self):
        with patch.dict(build['binding_tool'].__globals__, download=lambda value: b'0' * 64 if value.endswith('.sha256sum') else b'archive'), \
             patch('subprocess.run') as install:
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                build['binding_tool'](self.root, None, '1.95.0')
        install.assert_not_called()


if __name__ == '__main__':
    unittest.main()
