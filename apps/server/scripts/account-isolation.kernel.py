"""Qualify the Linux account execution boundary with fresh synthetic state only.

Run in a disposable root-owned sandbox with private /tmp and no host-home mounts.
This proves kernel file and privilege separation, not native API/fleet acceptance.
"""

import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile


PROBE = r"""
import json, os, subprocess, sys
from pathlib import Path
p = json.load(sys.stdin)
assert os.getuid() == p['uid']
assert os.getgid() == p['uid']
assert os.getgroups() == []
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert int(status['CapEff'].strip(), 16) == 0
assert int(status['CapBnd'].strip(), 16) == 0
assert status['NoNewPrivs'].strip() == '1'
regain = subprocess.run(['/usr/bin/setpriv', '--reuid', '0', '--', '/usr/bin/id', '-u'], capture_output=True, timeout=5)
assert regain.returncode != 0
assert Path(p['own_provider']).read_text() == 'synthetic provider credential'
assert Path(p['own_workspace']).read_text() == 'synthetic workspace'
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'CODEX_HOME', 'T3CODE_DEV_AUTH_TOKEN'])
denied = {}
for label, file in p['forbidden'].items():
    try:
        Path(file).read_bytes()
    except PermissionError:
        denied[label] = True
    else:
        raise AssertionError('cross-account read succeeded: ' + label)
    shell = subprocess.run(['/bin/sh', '-c', 'cat "$1"', 'probe', file], capture_output=True, timeout=5)
    assert shell.returncode != 0 and shell.stdout == b''
print(json.dumps({'account': p['account'], 'uid': os.getuid(), 'effective_caps': 0, 'bounding_caps': 0, 'no_new_privileges': True, 'privilege_escalation_denied': True, 'forged_account_label_ignored': os.environ['ACCOUNT_ID'] != p['account'], 'denied': denied}))
"""


def write_private(file, value, uid):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(file.parent, uid, uid)
    file.write_text(value)
    file.chmod(0o600)
    os.chown(file, uid, uid)


def run():
    if sys.platform != "linux" or os.geteuid() != 0 or shutil.which("setpriv") is None:
        print(json.dumps({"status": "unavailable", "requires": "disposable Linux root sandbox with setpriv"}))
        return 77
    with tempfile.TemporaryDirectory(prefix="clo866-account-kernel-") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        control = root / "control"
        control.mkdir(mode=0o700)
        session = control / "human-session.token"
        write_private(session, "synthetic human session", 0)
        db = control / "statev2.sqlite"
        with sqlite3.connect(db) as connection:
            connection.execute("CREATE TABLE fixture (value TEXT)")
            connection.execute("INSERT INTO fixture VALUES ('synthetic control state')")
        db.chmod(0o600)
        accounts = []
        for name, uid in [("kameron", 65000), ("jeff", 65001)]:
            home = root / name
            home.mkdir(mode=0o700)
            os.chown(home, uid, uid)
            provider = home / ".codex" / "auth.json"
            workspace = home / "workspace" / "private.txt"
            database = home / "history" / "statev2.sqlite"
            write_private(provider, "synthetic provider credential", uid)
            write_private(workspace, "synthetic workspace", uid)
            database.parent.mkdir(mode=0o700)
            os.chown(database.parent, uid, uid)
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE fixture (account TEXT)")
                connection.execute("INSERT INTO fixture VALUES (?)", (name,))
            database.chmod(0o600)
            os.chown(database, uid, uid)
            accounts.append((name, uid, home, provider, workspace, database))
        results = []
        for index, (name, uid, home, provider, workspace, database) in enumerate(accounts):
            other = accounts[1 - index]
            payload = {
                "account": name,
                "uid": uid,
                "own_provider": str(provider),
                "own_workspace": str(workspace),
                "forbidden": {
                    "other_provider_home": str(other[3]),
                    "other_workspace": str(other[4]),
                    "other_database": str(other[5]),
                    "controller_database": str(db),
                    "human_session": str(session),
                },
            }
            result = subprocess.run(
                ["/usr/bin/setpriv", "--reuid", str(uid), "--regid", str(uid),
                 "--clear-groups", "--bounding-set=-all", "--no-new-privs", "--",
                 sys.executable, "-c", PROBE],
                input=json.dumps(payload), text=True, capture_output=True, timeout=15,
                cwd=home,
                env={"HOME": str(home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "ACCOUNT_ID": other[0]},
            )
            if result.returncode != 0:
                raise RuntimeError(f"synthetic {name} isolation probe failed: {result.stderr}")
            results.append(json.loads(result.stdout))
        print(json.dumps({"status": "passed", "scope": "synthetic Linux kernel boundary only", "accounts": results}))
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
