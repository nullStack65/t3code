#!/usr/bin/env python3
"""Read-only release arrival report. ISO-week grouping; no event means no run."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

from guard import assessment, git, parse_manifest

UPSTREAM = 'pingdotgg/t3code'
FORK = 'nullStack65/t3code'


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True))


def validate(payload, release, commit):
    if payload.get('repository') != UPSTREAM or payload.get('action') != 'published':
        raise ValueError('expected canonical upstream published release arrival')
    rid = payload.get('release_id')
    if type(rid) is not int or rid <= 0 or release.get('id') != rid:
        raise ValueError('release ID mismatch')
    tag = release.get('tag_name', '')
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', tag):
        raise ValueError('unsupported version tag; classify manually')
    if payload.get('tag_name') != tag or release.get('draft') is not False or not release.get('published_at'):
        raise ValueError('tag mismatch, draft or unpublished release')
    if release.get('html_url') != f'https://github.com/{UPSTREAM}/releases/tag/{tag}':
        raise ValueError('foreign release URL')
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or payload.get('commit') != commit:
        raise ValueError('release tag commit mismatch')
    datetime.fromisoformat(release['published_at'].replace('Z', '+00:00'))
    return release


def iso_week(date):
    day = datetime.fromisoformat(date.replace('Z', '+00:00')).astimezone(timezone.utc)
    year, week, _ = day.isocalendar()
    return f'{year}-W{week:02}'


def artifact_name(release, commit):
    return f'upstream-drift-{iso_week(release["published_at"])}-r{release["id"]}-{commit}'


def duplicate(artifacts, name):
    return any(a.get('name') == name and a.get('expired') is False for a in artifacts)


def fetch_commit(sha):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('unknown canonical Git identity')
    git('.', 'fetch', '--no-tags', f'https://github.com/{UPSTREAM}.git', sha)
    if git('.', 'rev-parse', 'FETCH_HEAD').decode().strip() != sha:
        raise ValueError('fetched identity mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event', required=True)
    parser.add_argument('--out', default='fork-drift-report')
    args = parser.parse_args()
    event = json.loads(Path(args.event).read_text())
    recovery = 'client_payload' not in event
    payload = event.get('client_payload')
    if recovery:
        # Manual recovery is distinctly marked. Inputs never become commands.
        rid = int(event['inputs']['release_id'])
        payload = {'repository': UPSTREAM, 'action': 'published', 'release_id': rid}
    if payload.get('repository') != UPSTREAM or type(payload.get('release_id')) is not int:
        raise ValueError('invalid dispatch source/ID')
    release = api(f'repos/{UPSTREAM}/releases/{payload["release_id"]}')
    tag = release.get('tag_name', '')
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', tag):
        raise ValueError('unsupported release tag')
    commit = api(f'repos/{UPSTREAM}/commits/{quote(tag, safe="")}')['sha']
    if recovery:
        payload.update(tag_name=tag, commit=commit)
    validate(payload, release, commit)
    name = artifact_name(release, commit)
    # Paginate all retained artifacts: absence on page one is not absence.
    artifacts = json.loads(subprocess.check_output(
        ['gh', 'api', '--paginate', '--slurp', f'repos/{FORK}/actions/artifacts?per_page=100'], text=True))
    seen = duplicate([a for page in artifacts for a in page['artifacts']], name)
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a') as stream:
            stream.write(f'artifact={name}\nduplicate={str(seen).lower()}\n')
    if seen:
        summary = 'Duplicate canonical release arrival; retained artifact already exists: ' + name
    else:
        upstream = api(f'repos/{UPSTREAM}/git/ref/heads/main')['object']['sha']
        fetch_commit(commit)
        fetch_commit(upstream)
        head = git('.', 'rev-parse', 'HEAD').decode().strip()
        manifest = parse_manifest(git('.', 'show', head + ':FORK_DELTA.md').decode())
        # GitHub's release endpoint is read-only; all code remains the trusted checkout.
        sources = {'fork_candidate': head, **manifest['lineages']}
        for target in sources.values():
            # Additional historical lineage objects must already be available locally or fetched
            # from our fork by exact pinned SHA, never a payload-provided URL/ref.
            try:
                git('.', 'cat-file', '-e', target + '^{commit}')
            except subprocess.CalledProcessError:
                git('.', 'fetch', '--no-tags', f'https://github.com/{FORK}.git', target)
        report = {'trigger': 'manual-recovery' if recovery else 'repository_dispatch',
                  'automatic_ingress_verified': False,
                  'release': {k: release[k] for k in ['id', 'tag_name', 'published_at', 'html_url']},
                  'release_commit': commit, 'upstream_main': upstream, 'fork_head': head,
                  'week': iso_week(release['published_at']),
                  'dedupe': 'retained artifact by release ID + canonical commit; expiry permits replay',
                  'comparisons': {refname: {name: assessment('.', target, ref, (upstream,) if ref != upstream else ()) for name, target in sources.items()}
                                  for refname, ref in {'release': commit, 'main': upstream}.items()}}
        # Weekly cohort is rebuilt on arrivals, with pagination; there is no scheduled run.
        pages = json.loads(subprocess.check_output(
            ['gh', 'api', '--paginate', '--slurp', f'repos/{UPSTREAM}/releases?per_page=100'], text=True))
        cohort = [r for page in pages for r in page if not r['draft'] and r.get('published_at')
                  and iso_week(r['published_at']) == report['week']]
        report['week_releases'] = [{k: r[k] for k in ['id', 'tag_name', 'published_at']} for r in cohort]
        directory = Path(args.out)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        summary = (f'# Upstream drift {report["week"]}\n\n'
                   f'Release [{tag}]({release["html_url"]}) (`{commit}`); fork `{head}`; '
                   f'upstream main `{upstream}`.\n\n'
                   f'Trigger: {report["trigger"]}. {len(cohort)} published releases in this ISO week. '
                   'No event means no run. Source-only comparison; no deployment or patch approval.\n\n'
                   'Automatic upstream delivery is unverified: the authorized webhook owner must '
                   'connect a real upstream release source; a dispatch receiver alone is not a subscription.\n\n')
        for refname, subjects in report['comparisons'].items():
            for subject, rows in subjects.items():
                summary += (f'- {refname}/{subject}: {len(rows)} ancestry-only commits; '
                            f'{sum(bool(r["upstream_matches"]) for r in rows)} exact stable-patch matches.\n')
        (directory / 'report.md').write_text(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(summary + '\n')
    print(summary)


if __name__ == '__main__':
    main()
