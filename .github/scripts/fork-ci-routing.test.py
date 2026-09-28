import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("fork-ci-routing.sh")
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"
REPOSITORY = "nullStack65/t3code"

# Every input the guard reads. Cleared from the inherited environment so a
# developer's own shell cannot change a fixture's outcome.
INPUTS = (
    "EVENT_NAME",
    "HEAD_REPO",
    "REPOSITORY",
    "AUTHORIZED",
    "T3CODE_LINUX_RUNNER",
    "T3CODE_MACOS_X64_RUNNER",
    "REQUIRED_ROLES",
)

BEGIN = "# >>> fork-ci-bootstrap >>>"
END = "# <<< fork-ci-bootstrap <<<"

# The canonical routing decisions. The workflow's inline first-introduction
# bootstrap must reproduce every one of these, so the same table drives both the
# guard and the bootstrap.
CASES = (
    (
        "trusted push on authorized linux",
        dict(EVENT_NAME="push", AUTHORIZED="t3-ci-linux, t3-ci-macos", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        0,
        "ADMITTED",
    ),
    (
        "same-repository pull request",
        dict(EVENT_NAME="pull_request", HEAD_REPO=REPOSITORY, AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        0,
        "ADMITTED",
    ),
    (
        "external fork pull request",
        dict(EVENT_NAME="pull_request", HEAD_REPO="someone-else/t3code", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        3,
        "UNTRUSTED_FORK",
    ),
    (
        "pull request with empty head repository",
        dict(EVENT_NAME="pull_request", HEAD_REPO="", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        3,
        "UNTRUSTED_FORK",
    ),
    (
        "missing authorized list",
        dict(EVENT_NAME="push", AUTHORIZED="", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        2,
        "CAPACITY_NOT_CONFIGURED",
    ),
    (
        "missing runner variable",
        dict(EVENT_NAME="push", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER=""),
        2,
        "CAPACITY_NOT_CONFIGURED",
    ),
    (
        "unauthorized label",
        dict(EVENT_NAME="push", AUTHORIZED="some-other-runner", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        4,
        "RUNNER_NOT_AUTHORIZED",
    ),
    (
        "macos role required and admitted",
        dict(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux, t3-ci-macos",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="t3-ci-macos",
            REQUIRED_ROLES="linux macos",
        ),
        0,
        "ADMITTED",
    ),
    (
        "macos role required but unset",
        dict(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="",
            REQUIRED_ROLES="linux macos",
        ),
        2,
        "CAPACITY_NOT_CONFIGURED",
    ),
    (
        "unknown required role",
        dict(EVENT_NAME="push", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux", REQUIRED_ROLES="windows"),
        2,
        "CAPACITY_NOT_CONFIGURED",
    ),
    (
        "unknown event",
        dict(EVENT_NAME="workflow_dispatch", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        5,
        "UNTRUSTED_CONTEXT",
    ),
    (
        "unidentified repository",
        dict(EVENT_NAME="push", REPOSITORY="", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="t3-ci-linux"),
        5,
        "UNTRUSTED_CONTEXT",
    ),
)


def environment(values):
    env = {k: v for k, v in os.environ.items() if k not in INPUTS}
    env["REPOSITORY"] = REPOSITORY
    env.update(values)
    return env


def dedent(lines):
    widths = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    width = min(widths) if widths else 0
    return "\n".join(line[width:] if line.strip() else "" for line in lines)


def extract_bootstrap_blocks():
    lines = WORKFLOW.read_text().splitlines()
    blocks = []
    current = None
    for line in lines:
        if BEGIN in line:
            current = []
        elif END in line:
            if current is None:
                raise AssertionError(f"{END} without {BEGIN}")
            blocks.append(dedent(current))
            current = None
        elif current is not None:
            current.append(line)
    if current is not None:
        raise AssertionError(f"{BEGIN} without {END}")
    return blocks


class ForkCiRoutingTests(unittest.TestCase):
    def run_script(self, script, values, cwd=None):
        return subprocess.run(
            ["bash", str(script)],
            env=environment(values),
            cwd=cwd,
            capture_output=True,
            text=True,
        )

    def run_guard(self, **values):
        return self.run_script(SCRIPT, values)

    def test_guard_decision_table(self):
        for name, values, code, token in CASES:
            with self.subTest(name=name):
                result = self.run_guard(**values)
                self.assertIn(token, result.stdout + result.stderr, result.stderr)
                self.assertEqual(result.returncode, code, result.stderr)
                if code == 0:
                    self.assertNotIn("ADMITTED", result.stderr)
                    self.assertTrue(result.stdout.strip().startswith("ADMITTED"))

    def test_admits_trusted_push_output(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux, t3-ci-macos",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ADMITTED linux=t3-ci-linux")

    def test_requires_and_admits_macos_role_output(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux, t3-ci-macos",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="t3-ci-macos",
            REQUIRED_ROLES="linux macos",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ADMITTED linux=t3-ci-linux macos=t3-ci-macos")

    def test_missing_authorized_list_mentions_variable(self):
        result = self.run_guard(EVENT_NAME="push", AUTHORIZED="", T3CODE_LINUX_RUNNER="t3-ci-linux")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("T3CODE_AUTHORIZED_RUNNERS", result.stderr)

    def test_missing_runner_variable_mentions_variable(self):
        result = self.run_guard(EVENT_NAME="push", AUTHORIZED="t3-ci-linux", T3CODE_LINUX_RUNNER="")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("T3CODE_LINUX_RUNNER", result.stderr)

    def test_missing_macos_capacity_mentions_variable(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="",
            REQUIRED_ROLES="linux macos",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("T3CODE_MACOS_X64_RUNNER", result.stderr)

    def test_bootstrap_blocks_match(self):
        blocks = extract_bootstrap_blocks()
        self.assertEqual(len(blocks), 2, "expected one bootstrap per authorize job")
        self.assertEqual(blocks[0], blocks[1], "the two bootstrap copies drifted")


class ForkCiBootstrapTests(unittest.TestCase):
    """Run the workflow's actual inline bootstrap, not only the guard file."""

    def setUp(self):
        self.blocks = extract_bootstrap_blocks()
        self.assertTrue(self.blocks, "no bootstrap block found in ci.yml")

    def materialize(self, tree_has_guard):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        if tree_has_guard:
            guard = root / ".github" / "scripts" / "fork-ci-routing.sh"
            guard.parent.mkdir(parents=True)
            guard.write_text(SCRIPT.read_text())
        script = root / "bootstrap.sh"
        script.write_text(self.blocks[0] + "\n")
        return root, script

    def run_bootstrap(self, root, script, values):
        return subprocess.run(
            ["bash", str(script)],
            env=environment(values),
            cwd=str(root),
            capture_output=True,
            text=True,
        )

    def test_first_introduction_runs_inline_policy(self):
        # Actual pull request base tree on first introduction: no guard file.
        root, script = self.materialize(tree_has_guard=False)
        for name, values, code, token in CASES:
            with self.subTest(name=name):
                result = self.run_bootstrap(root, script, values)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertIn(token, result.stdout + result.stderr, result.stderr)

    def test_later_pull_request_runs_checked_out_guard(self):
        # Once the guard is on the default branch the base tree carries it.
        root, script = self.materialize(tree_has_guard=True)
        for name, values, code, token in CASES:
            with self.subTest(name=name):
                result = self.run_bootstrap(root, script, values)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertIn(token, result.stdout + result.stderr, result.stderr)

    def test_bootstrap_and_guard_agree(self):
        root, script = self.materialize(tree_has_guard=False)
        for name, values, code, token in CASES:
            with self.subTest(name=name):
                inline = self.run_bootstrap(root, script, values)
                guard = subprocess.run(
                    ["bash", str(SCRIPT)],
                    env=environment(values),
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(inline.returncode, guard.returncode, name)
                self.assertEqual(inline.stdout, guard.stdout, name)
                self.assertEqual(inline.stderr, guard.stderr, name)


if __name__ == "__main__":
    unittest.main()
