import os
import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("fork-ci-routing.sh")
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


class ForkCiRoutingTests(unittest.TestCase):
    def run_guard(self, **values):
        env = {k: v for k, v in os.environ.items() if k not in INPUTS}
        env["REPOSITORY"] = REPOSITORY
        env.update(values)
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=env,
            capture_output=True,
            text=True,
        )

    def test_admits_trusted_push_on_authorized_linux(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux, t3-ci-macos",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ADMITTED linux=t3-ci-linux")

    def test_admits_same_repository_pull_request(self):
        result = self.run_guard(
            EVENT_NAME="pull_request",
            HEAD_REPO=REPOSITORY,
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ADMITTED", result.stdout)

    def test_rejects_external_fork_pull_request(self):
        result = self.run_guard(
            EVENT_NAME="pull_request",
            HEAD_REPO="someone-else/t3code",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("UNTRUSTED_FORK", result.stderr)
        self.assertNotIn("ADMITTED", result.stdout)

    def test_missing_authorized_list_is_capacity_not_configured(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("CAPACITY_NOT_CONFIGURED", result.stderr)
        self.assertIn("T3CODE_AUTHORIZED_RUNNERS", result.stderr)

    def test_missing_runner_variable_is_capacity_not_configured(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("CAPACITY_NOT_CONFIGURED", result.stderr)
        self.assertIn("T3CODE_LINUX_RUNNER", result.stderr)

    def test_unauthorized_label_is_rejected(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="some-other-runner",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
        )
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("RUNNER_NOT_AUTHORIZED", result.stderr)

    def test_requires_and_admits_macos_role(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux, t3-ci-macos",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="t3-ci-macos",
            REQUIRED_ROLES="linux macos",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ADMITTED linux=t3-ci-linux macos=t3-ci-macos")

    def test_missing_macos_capacity_when_required(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            T3CODE_MACOS_X64_RUNNER="",
            REQUIRED_ROLES="linux macos",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("CAPACITY_NOT_CONFIGURED", result.stderr)
        self.assertIn("T3CODE_MACOS_X64_RUNNER", result.stderr)

    def test_unknown_role_is_capacity_not_configured(self):
        result = self.run_guard(
            EVENT_NAME="push",
            AUTHORIZED="t3-ci-linux",
            T3CODE_LINUX_RUNNER="t3-ci-linux",
            REQUIRED_ROLES="windows",
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("CAPACITY_NOT_CONFIGURED", result.stderr)


if __name__ == "__main__":
    unittest.main()