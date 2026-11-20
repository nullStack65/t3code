import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from guard import START, END, assessment, check, digest, git, identity, render_manifest, parse_manifest


class Histories(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fork-delta-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        git(self.repo, 'init', '-b', 'main')
        git(self.repo, 'config', 'user.name', 'Synthetic')
        git(self.repo, 'config', 'user.email', 'synthetic@example.invalid')
        self.base = self.commit('code', 'base\n')

    def commit(self, path, value):
        (self.repo / path).write_text(value)
        git(self.repo, 'add', path)
        git(self.repo, 'commit', '-m', 'synthetic')
        return git(self.repo, 'rev-parse', 'HEAD').decode().strip()

    def document(self, rows=(), maintenance=None):
        entries = [{**identity(self.repo, sha), 'decision': 'retain-candidate',
                    'why': 'Synthetic behavior exercised', 'evidence': ['code']} for sha in rows]
        return START + json.dumps({'schema': 1, 'references': {'official': self.base, 'main': self.base},
                                  'lineages': {}, 'entries': entries,
                                  'maintenance': maintenance or {}}) + END

    def test_original_unlisted_source_fails_then_explicit_entry_passes(self):
        head = self.commit('code', 'different behavior\n')
        with self.assertRaisesRegex(ValueError, 'unlisted patch'):
            check(self.repo, head, self.document())
        self.assertEqual(check(self.repo, head, self.document([head]))['main/candidate']['ancestry_only'], 1)

    def test_cherry_picked_upstream_is_patch_equivalent(self):
        git(self.repo, 'switch', '-c', 'upstream')
        upstream = self.commit('code', 'upstream fix\n')
        git(self.repo, 'switch', '-c', 'fork', self.base)
        local = self.commit('local-doc', 'separate ancestry\n')
        git(self.repo, 'cherry-pick', upstream)
        head = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        rows = assessment(self.repo, head, upstream)
        match = next(row for row in rows if row['commit'] == head)
        self.assertEqual(match['upstream_matches'], [upstream])
        self.assertNotEqual(head, upstream)
        accepted = self.document([local])
        manifest = parse_manifest(accepted)
        manifest['references'] = {'official': upstream, 'main': upstream}
        accepted = render_manifest(accepted, manifest)
        check(self.repo, head, accepted)
        # Equivalent patch is exempt, unrelated preceding effect remains blocked.
        with self.assertRaisesRegex(ValueError, 'unlisted patch'):
            text = self.document().replace(self.base, upstream)
            check(self.repo, head, text)

    def test_upstream_extra_effect_is_not_whole_patch_equivalence(self):
        git(self.repo, 'switch', '-c', 'upstream')
        (self.repo / 'extra').write_text('also changes behavior\n')
        git(self.repo, 'add', 'extra')
        upstream = self.commit('code', 'upstream fix\n')
        git(self.repo, 'switch', '-c', 'fork', self.base)
        head = self.commit('code', 'upstream fix\n')
        row = assessment(self.repo, head, upstream)[0]
        self.assertEqual(row['upstream_matches'], [])

    def test_newer_upstream_import_is_not_misclassified_as_custom(self):
        upstream = self.commit('code', 'new official code\n')
        text = self.document().replace('"main": "' + self.base, '"main": "' + upstream)
        counts = check(self.repo, upstream, text)
        self.assertEqual(counts['official/candidate']['ancestor_of_other_reference'], 1)

    def test_unknown_reference_fails_closed(self):
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            check(self.repo, self.base, self.document().replace(self.base, 'a' * 40))

    def test_merge_resolution_never_disappears(self):
        git(self.repo, 'switch', '-c', 'side')
        side = self.commit('code', 'side\n')
        git(self.repo, 'switch', 'main')
        main = self.commit('code', 'main\n')
        with self.assertRaises(subprocess.CalledProcessError):
            git(self.repo, 'merge', '--no-ff', 'side', '-m', 'merge')
        self.commit('code', 'UNLISTED RESOLUTION\n')
        head = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(ValueError, 'unlisted patch ' + head):
            check(self.repo, head, self.document([side, main]))
        check(self.repo, head, self.document([side, main, head]))

    def test_clean_merge_composes_only_already_listed_patches(self):
        git(self.repo, 'switch', '-c', 'side')
        side = self.commit('side', 'side\n')
        git(self.repo, 'switch', 'main')
        main = self.commit('main', 'main\n')
        git(self.repo, 'merge', '--no-ff', 'side', '-m', 'merge')
        head = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        check(self.repo, head, self.document([side, main]))
        with self.assertRaisesRegex(ValueError, 'unlisted patch ' + side):
            check(self.repo, head, self.document([main]))

    def test_bounded_self_reference_and_unknown_file(self):
        text = self.document()
        policy = {'files': {'FORK_DELTA.md': digest('FORK_DELTA.md', text.encode())}}
        data = json.loads(text.split(START)[1].split(END)[0])
        data['maintenance'] = policy
        text = render_manifest(text, data)
        head = self.commit('FORK_DELTA.md', text)
        check(self.repo, head, text)
        extra = self.commit('arbitrary-code', 'not allowed\n')
        with self.assertRaisesRegex(ValueError, 'unlisted patch ' + extra):
            check(self.repo, extra, text)
        changed = self.commit('FORK_DELTA.md', text + '\nunlisted prose\n')
        with self.assertRaisesRegex(ValueError, 'unlisted patch ' + changed):
            check(self.repo, changed, text)

    def test_maintenance_cannot_admit_arbitrary_source_even_with_exact_hash(self):
        head = self.commit('code', 'unauthorized code\n')
        text = self.document(maintenance={'files': {'code': digest('code', b'unauthorized code\n')}})
        with self.assertRaisesRegex(ValueError, 'maintenance exception cannot expand'):
            check(self.repo, head, text)

    def test_identity_tampering_and_unresolved_classification(self):
        head = self.commit('code', 'change\n')
        text = self.document([head])
        with self.assertRaisesRegex(ValueError, 'mismatched identity'):
            check(self.repo, head, text.replace(identity(self.repo, head)['tree'], '0' * 40))
        with self.assertRaisesRegex(ValueError, 'unresolved classification'):
            check(self.repo, head, text.replace('retain-candidate', 'needs-classification'))

    def test_reverted_unknown_effect_does_not_hide(self):
        first = self.commit('code', 'unlisted then reverted\n')
        self.commit('code', 'base\n')
        with self.assertRaisesRegex(ValueError, 'unlisted patch ' + first):
            check(self.repo, git(self.repo, 'rev-parse', 'HEAD').decode().strip(), self.document())


if __name__ == '__main__':
    unittest.main()
