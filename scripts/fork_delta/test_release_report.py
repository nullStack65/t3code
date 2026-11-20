import unittest
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
import release_report
from release_report import artifact_name, duplicate, iso_week, validate


class ReleaseArrivals(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 40
        self.payload = {'repository': 'pingdotgg/t3code', 'action': 'published',
                        'release_id': 42, 'tag_name': 'v0.1.2', 'commit': self.sha}
        self.release = {'id': 42, 'tag_name': 'v0.1.2', 'draft': False,
                        'published_at': '2026-11-13T12:00:00Z',
                        'html_url': 'https://github.com/pingdotgg/t3code/releases/tag/v0.1.2'}

    def test_canonical_release_and_identity(self):
        self.assertEqual(validate(self.payload, self.release, self.sha), self.release)
        for key, value in [('repository', 'foreign/t3code'), ('action', 'edited'),
                           ('release_id', True), ('release_id', 43), ('tag_name', 'v0.1.3'),
                           ('commit', 'b' * 40)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate({**self.payload, key: value}, self.release, self.sha)

    def test_draft_unpublished_foreign_or_unsafe_tag(self):
        for key, value in [('draft', True), ('published_at', None),
                           ('html_url', 'https://example.invalid'), ('tag_name', '--upload-pack=bad')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(self.payload, {**self.release, key: value}, self.sha)

    def test_week_boundary_and_deduplication(self):
        self.assertEqual(iso_week('2027-01-01T12:00:00Z'), '2026-W53')
        name = artifact_name(self.release, self.sha)
        self.assertTrue(duplicate([{'name': name, 'expired': False}], name))
        self.assertFalse(duplicate([{'name': name, 'expired': True}], name))
        self.assertFalse(duplicate([{'name': name, 'expired': False}], name + 'other'))

    def test_receiver_emits_bound_artifact_and_reconciles_duplicate(self):
        for already_seen in [False, True]:
            with self.subTest(duplicate=already_seen), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                event = root / 'event.json'
                event.write_text(json.dumps({'client_payload': self.payload}))
                output = root / 'report'
                output_file = root / 'outputs'
                summary_file = root / 'summary'
                from guard import START, END
                text = START + json.dumps({'lineages': {'air': 'b' * 40}}) + END
                def fake_api(path):
                    if '/releases/' in path:
                        return self.release
                    if '/commits/' in path:
                        return {'sha': self.sha}
                    if path.endswith('/git/ref/heads/main'):
                        return {'object': {'sha': 'c' * 40}}
                    raise AssertionError(path)
                def fake_git(repo, *args):
                    if args[0] == 'rev-parse':
                        return ('d' * 40 + '\n').encode()
                    if args[0] == 'show':
                        return text.encode()
                    if args[0] == 'cat-file':
                        return b''
                    raise AssertionError(args)
                def fake_pages(args, **kwargs):
                    if '/actions/artifacts?' in args[-1]:
                        artifacts = ([{'name': artifact_name(self.release, self.sha), 'expired': False}]
                                     if already_seen else [])
                        return json.dumps([{'artifacts': artifacts}])
                    return json.dumps([[self.release, {**self.release, 'id': 43,
                                                      'published_at': '2026-11-01T00:00:00Z'}]])
                with patch.object(release_report, 'api', side_effect=fake_api), \
                     patch.object(release_report, 'git', side_effect=fake_git), \
                     patch.object(release_report, 'fetch_commit') as fetch, \
                     patch.object(release_report, 'assessment', return_value=[]), \
                     patch.object(release_report.subprocess, 'check_output', side_effect=fake_pages), \
                     patch.dict(os.environ, {'GITHUB_OUTPUT': str(output_file),
                                             'GITHUB_STEP_SUMMARY': str(summary_file)}), \
                     patch('sys.argv', ['report', '--event', str(event), '--out', str(output)]), \
                     contextlib.redirect_stdout(io.StringIO()):
                    release_report.main()
                if already_seen:
                    self.assertFalse(output.exists())
                    fetch.assert_not_called()
                    self.assertIn('Duplicate canonical release arrival', summary_file.read_text())
                else:
                    report = json.loads((output / 'report.json').read_text())
                    self.assertEqual(report['release_commit'], self.sha)
                    self.assertEqual(report['fork_head'], 'd' * 40)
                    self.assertEqual([r['id'] for r in report['week_releases']], [42])
                    self.assertFalse(report['automatic_ingress_verified'])
                    self.assertEqual(fetch.call_count, 2)
                self.assertIn('duplicate=' + str(already_seen).lower(), output_file.read_text())


if __name__ == '__main__':
    unittest.main()
