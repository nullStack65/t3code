#!/usr/bin/env python3
"""List ancestry and patch identity; require explicit fork inventory, never approval."""
import argparse
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

START = '<!-- fork-delta-manifest:start -->\n```json\n'
END = '\n```\n<!-- fork-delta-manifest:end -->'
DECISIONS = {'retain-candidate', 'retire-candidate', 'upstream-covered', 'proposal'}
MAINTENANCE_PATHS = {
    'FORK_DELTA.md', '.github/workflows/fork-delta.yml',
    '.github/workflows/fork-upstream-drift.yml',
    'scripts/fork_delta/guard.py', 'scripts/fork_delta/test_guard.py',
    'scripts/fork_delta/release_report.py', 'scripts/fork_delta/test_release_report.py',
}


def git(repo, *args, data=None):
    return subprocess.run(['git', '-C', str(repo), *args], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def resolve(repo, ref):
    if not re.fullmatch(r'[a-f0-9]{40}', ref):
        raise ValueError('expected immutable full commit SHA: ' + ref)
    result = git(repo, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    if result != ref:
        raise ValueError('commit identity mismatch')
    return result


def commits(repo, head, upstream):
    resolve(repo, head)
    resolve(repo, upstream)
    return git(repo, 'rev-list', '--reverse', head, '^' + upstream).decode().split()


@lru_cache(maxsize=32)
def changed_path_index(repo, ref):
    resolve(repo, ref)
    # Stable patch IDs include every filename. Index the complete changed-path
    # sets first so unrelated large/binary upstream diffs need not be hashed.
    log = git(repo, 'log', '--no-merges', '--pretty=format:%x1e%H',
              '--name-only', '--no-renames', ref).decode()
    result = {}
    for record in log.split('\x1e'):
        if not record.strip():
            continue
        lines = record.strip('\n').splitlines()
        sha = lines[0]
        if not re.fullmatch(r'[a-f0-9]{40}', sha):
            raise ValueError('malformed upstream commit record')
        paths = frozenset(line for line in lines[1:] if line)
        result.setdefault(paths, []).append(sha)
    return result


def changed_paths(repo, sha):
    return frozenset(git(repo, 'diff-tree', '--root', '--no-commit-id',
                         '--name-only', '--no-renames', '-r', sha).decode().splitlines())


def patch_ids(repo, ref, path_sets):
    index = changed_path_index(repo, ref)
    result = {}
    for paths in path_sets:
        for sha in index.get(paths, []):
            result[sha] = identity(repo, sha)['patch_id']
    return result


@lru_cache(maxsize=2048)
def identity(repo, sha):
    parents = git(repo, 'show', '-s', '--format=%P', sha).decode().strip().split()
    tree = git(repo, 'rev-parse', sha + '^{tree}').decode().strip()
    patch = git(repo, 'show', '--pretty=format:', '--binary', '--no-renames', sha) if len(parents) < 2 else b''
    lines = git(repo, 'patch-id', '--stable', data=patch).decode().split()
    # Tree AND parents bind merges, including conflict resolutions and empty merges.
    return {'commit': sha, 'parents': parents, 'tree': tree,
            'patch_id': lines[0] if lines else None}


def parse_manifest(text):
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError('one bounded manifest required')
    return json.loads(text.split(START)[1].split(END)[0])


def render_manifest(text, manifest):
    before, rest = text.split(START)
    _, after = rest.split(END)
    return before + START + json.dumps(manifest, indent=2) + END + after


def digest(path, body):
    if path == 'FORK_DELTA.md':
        text = body.decode()
        manifest = parse_manifest(text)
        manifest['maintenance'] = {}
        body = render_manifest(text, manifest).encode()
    return hashlib.sha256(body).hexdigest()


def assessment(repo, head, upstream, other_references=()):
    inherited = set(git(repo, 'rev-list', *other_references).decode().split()) if other_references else set()
    rows = []
    path_sets = set()
    for sha in commits(repo, head, upstream):
        if sha in inherited:
            rows.append({'commit': sha, 'parents': [], 'patch_id': None,
                         'coverage': 'ancestor-of-other-reference', 'upstream_matches': []})
            continue
        item = dict(identity(repo, sha))
        if item['patch_id']:
            path_sets.add(changed_paths(repo, sha))
        rows.append(item)
    reverse = {}
    for sha, patch in patch_ids(repo, upstream, path_sets).items():
        if patch:
            reverse.setdefault(patch, []).append(sha)
    for item in rows:
        if item.get('coverage') == 'ancestor-of-other-reference':
            continue
        item['upstream_matches'] = reverse.get(item['patch_id'], [])
        item['coverage'] = 'patch-equivalent' if item['upstream_matches'] else 'unique-or-manual'
    return rows


def maintenance_commit(repo, sha, policy):
    parents = identity(repo, sha)['parents']
    if len(parents) != 1:
        return False
    paths = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).decode().splitlines()
    expected = policy.get('files', {})
    if not set(expected) <= MAINTENANCE_PATHS:
        raise ValueError('maintenance exception cannot expand to arbitrary files')
    if not paths or not set(paths) <= set(expected):
        return False
    for path in paths:
        mode = git(repo, 'ls-tree', sha, '--', path).decode().split()[0]
        if mode != '100644':
            return False
        body = git(repo, 'show', sha + ':' + path)
        if digest(path, body) != expected[path]:
            return False
    return True


def composed_merge(repo, sha):
    parents = identity(repo, sha)['parents']
    if len(parents) != 2:
        return False
    try:
        tree = git(repo, 'merge-tree', '--write-tree', *parents).decode().splitlines()[0]
    except subprocess.CalledProcessError:
        return False
    return tree == identity(repo, sha)['tree']


def check(repo, head, text):
    if git(repo, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('complete history required')
    manifest = parse_manifest(text)
    if manifest['schema'] != 1:
        raise ValueError('unknown manifest schema')
    entries = manifest['entries']
    known = {}
    for entry in entries:
        sha = resolve(repo, entry['commit'])
        if sha in known or any(entry.get(k) != v for k, v in identity(repo, sha).items()):
            raise ValueError('duplicate or mismatched identity: ' + sha)
        if entry['decision'] not in DECISIONS or not entry['why'].strip() or not entry['evidence']:
            raise ValueError('unresolved classification: ' + sha)
        known[sha] = entry
    errors = []
    counts = {}
    # Every external source lineage remains inventoried; not asserted installed.
    subjects = {'candidate': head, **manifest['lineages']}
    for reference, upstream in manifest['references'].items():
        for name, target in subjects.items():
            others = tuple(ref for ref in manifest['references'].values() if ref != upstream)
            rows = assessment(repo, target, upstream, others)
            counts[reference + '/' + name] = {
                'ancestry_only': len(rows),
                'patch_equivalent': sum(bool(x['upstream_matches']) for x in rows),
                'merges': sum(len(x['parents']) > 1 for x in rows),
                'ancestor_of_other_reference': sum(x['coverage'] == 'ancestor-of-other-reference' for x in rows),
            }
            for row in rows:
                if row['coverage'] == 'ancestor-of-other-reference':
                    continue
                if row['commit'] in known:
                    continue
                # Rebased/cherry-picked upstream code is already inventoried by exact patch.
                # Merge trees never acquire that exception.
                if row['upstream_matches'] and len(row['parents']) < 2:
                    continue
                # A clean two-parent composition has no new patch. Conflicts and
                # edited resolution trees require an explicit immutable inventory row.
                if name == 'candidate' and composed_merge(repo, row['commit']):
                    continue
                if name == 'candidate' and maintenance_commit(repo, row['commit'], manifest['maintenance']):
                    continue
                errors.append(reference + '/' + name + ': unlisted patch ' + row['commit'])
    if errors:
        raise ValueError('\n'.join(sorted(set(errors))))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='.')
    parser.add_argument('--head', default=None)
    parser.add_argument('--upstream', help='emit classification candidates, never auto-accept')
    args = parser.parse_args()
    head = args.head or git(args.repo, 'rev-parse', 'HEAD').decode().strip()
    resolve(args.repo, head)
    if args.upstream:
        print(json.dumps(assessment(args.repo, head, args.upstream), indent=2))
    else:
        text = git(args.repo, 'show', head + ':FORK_DELTA.md').decode()
        print(json.dumps(check(args.repo, head, text), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print('fork delta FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
