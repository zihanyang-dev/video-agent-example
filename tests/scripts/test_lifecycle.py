r"""Host CLI lifecycle tests, not sandbox isolation or SDK behavior tests.

Docker must be available. Supply a local immutable check image ID; for example:
    VID_CHECK_IMAGE=$(docker build --quiet -f deploy/docker/checks.Dockerfile .) \
        python3 tests/scripts/test_lifecycle.py -v
No image is built, pulled, tagged, or removed by this suite.
"""

import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.root = self.path / "workspace"
        shutil.copytree(ROOT / "scripts", self.root / "scripts")
        shutil.copytree(ROOT / "tests/scripts", self.root / "tests/scripts")
        shutil.copytree(ROOT / "tests/sandbox", self.root / "tests/sandbox")
        shutil.copytree(ROOT / "deploy", self.root / "deploy")
        shutil.copyfile(ROOT / "compose.yaml", self.root / "compose.yaml")
        ssh_config = self.root / ".cache/e2b/lima/e2b/ssh.config"
        ssh_config.parent.mkdir(parents=True)
        ssh_config.write_text("# CLI fault fixture only; never connect to a VM.\n")
        self.env = dict(
            os.environ,
            PATH=f"{self.path}:{os.environ['PATH']}",
            FIXTURE=str(self.path),
            VID_SETUP_TIMEOUT="3",
            VID_RUN_TIMEOUT="3",
            VID_READY_TIMEOUT="2",
        )

    def cli(self, name, body):
        file = self.path / name
        file.write_text("#!/bin/sh\n" + body)
        file.chmod(0o755)

    def run_script(self, script):
        return subprocess.run(
            ["sh", str(self.root / "scripts" / script)],
            env=self.env,
            check=False,
            capture_output=True,
            text=True,
            timeout=12,
        )

    def test_create_lost_ack_removes_real_owned_container(self):
        docker = shutil.which("docker")
        if docker is None:
            self.fail("Docker is required for the owned lost-ACK cases")
        info = subprocess.run(
            [docker, "info"], check=False, capture_output=True, text=True, timeout=10
        )
        self.assertEqual(
            info.returncode, 0, f"Docker daemon is required: {info.stderr}"
        )
        image = os.environ.get("VID_CHECK_IMAGE", "")
        self.assertRegex(
            image,
            r"^sha256:[0-9a-f]{64}$",
            "Set VID_CHECK_IMAGE to an immutable local check image ID; "
            "see the command in this file's docstring (mutable tags are not accepted)",
        )
        inspection = subprocess.run(
            [docker, "image", "inspect", "--format", "{{.Id}}", image],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(inspection.returncode, 0, inspection.stderr)
        self.assertEqual(inspection.stdout.strip(), image)
        self.env["VID_CHECK_IMAGE"] = image
        self.env["REAL_DOCKER"] = docker
        self.env["REAL_ROOT"] = str(ROOT)
        fixture = self.path / "docker"
        fixture.write_text("""#!/usr/bin/env python3
import os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ['FIXTURE'])
real = os.environ['REAL_DOCKER']
if args[0] == 'build':
    print(os.environ['VID_CHECK_IMAGE'])
elif args[0] == 'compose' and 'up' in args:
    # Native Compose now owns deployment creation. Lose its ACK after creating
    # real labelled resources; its real `down` must find only this project.
    project = args[args.index('--project-name') + 1]
    count = int(os.environ['LOST_CREATE'])
    for service in ['objects', 'server'][:count]:
        result = subprocess.run([real, 'create', '--network', 'none', '--name', f'{project}-{service}-1', '--label', f'com.docker.compose.project={project}', '--label', f'com.docker.compose.service={service}', '--label', 'com.docker.compose.config-hash=owned-fixture', os.environ['VID_CHECK_IMAGE']], check=False, capture_output=True, text=True)
        if result.returncode: sys.exit(result.returncode)
        with (root / 'resources').open('a') as log:
            log.write(f'container {result.stdout.strip()}\\n')
    (root / 'count').write_text(str(count))
    sys.exit(70)
elif args[0] == 'create' or args[:2] == ['network', 'create']:
    args = [os.environ['VID_CHECK_IMAGE'] if arg.startswith(('postgres:', 'redis:', 'pgsty/silo:')) else arg for arg in args]
    # The CLI fixture never executes mounted checks. Use a daemon-visible read-only source.
    args = [('type=bind,src=' + os.environ['REAL_ROOT'] + ',dst=' + arg.split(',dst=', 1)[1]) if arg.startswith('type=bind,src=') else arg for arg in args]
    result = subprocess.run([real, *args], check=False, capture_output=True, text=True)
    if result.returncode: sys.exit(result.returncode)
    kind = 'container' if args[0] == 'create' else 'network'
    with (root / 'resources').open('a') as log:
        log.write(f'{kind} {result.stdout.strip()}\\n')
    if kind == 'container':
        count = int((root / 'count').read_text()) + 1 if (root / 'count').exists() else 1
        (root / 'count').write_text(str(count))
        if count == int(os.environ['LOST_CREATE']):
            sys.exit(70)
    print(result.stdout, end='')
elif args[0] in ('start', 'exec'):
    sys.exit(0)  # No database needed to exercise create/cleanup ownership.
else:
    sys.exit(subprocess.run([real, *args]).returncode)
""")
        fixture.chmod(0o755)
        for script, mode, create in [
            ("database-check.sh", "test", 1),
            ("database-check.sh", "test", 2),
            ("database-check.sh", "test", 3),
            ("database-check.sh", "test", 4),
            ("database-check.sh", "verify", 3),
            ("check.sh", "test", 1),
            ("../tests/scripts/deployment-check.sh", "test", 1),
            ("../tests/scripts/deployment-check.sh", "test", 2),
            ("../tests/scripts/storage-check.sh", "test", 1),
            ("../tests/scripts/storage-check.sh", "test", 2),
            ("../tests/scripts/storage-check.sh", "test", 3),
        ]:
            with self.subTest(script=script, mode=mode, create=create):
                (self.path / "count").unlink(missing_ok=True)
                resources = self.path / "resources"
                resources.unlink(missing_ok=True)
                self.env["LOST_CREATE"] = str(create)
                try:
                    result = subprocess.run(
                        ["sh", str(self.root / "scripts" / script), mode],
                        env=self.env,
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=20,
                    )
                finally:
                    # Only exact IDs returned by this fixture are cleanup-authorized.
                    owned = (
                        [line.split() for line in resources.read_text().splitlines()]
                        if resources.exists()
                        else []
                    )
                    for kind, resource_id in owned:
                        self.assertRegex(resource_id, r"^[0-9a-f]{64}$")
                        self.addCleanup(
                            subprocess.run,
                            [
                                docker,
                                kind,
                                "rm",
                                *(["-fv"] if kind == "container" else []),
                                resource_id,
                            ],
                            check=False,
                            capture_output=True,
                            text=True,
                            timeout=10,
                        )
                self.assertEqual(result.returncode, 70, result.stderr)
                self.assertEqual(int((self.path / "count").read_text()), create)
                self.assertEqual(len(owned), create + (script not in ("check.sh", "../tests/scripts/deployment-check.sh")))
                for kind, resource_id in owned:
                    # List successfully, rather than mistaking daemon failure for removal.
                    remaining = subprocess.run(
                        [
                            docker,
                            kind,
                            "ls",
                            "-q",
                            "--no-trunc",
                            *(["-a"] if kind == "container" else []),
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    self.assertEqual(remaining.returncode, 0, remaining.stderr)
                    self.assertNotIn(
                        resource_id, remaining.stdout.split(), result.stderr
                    )
                print(
                    f"Lost-ACK cleanup verified: {script} {mode} create={create}; "
                    + ", ".join(f"{kind}:{resource_id}" for kind, resource_id in owned),
                    flush=True,
                )

    def test_stalled_build_has_deadline(self):
        self.cli("docker", 'echo $$ > "$FIXTURE/client"; exec sleep 60\n')
        try:
            result = self.run_script("check.sh")
        except subprocess.TimeoutExpired:
            os.kill(int((self.path / "client").read_text()), signal.SIGKILL)
            self.fail("Docker build exceeded bounded stage deadline")
        self.assertNotEqual(result.returncode, 0)

    def test_stalled_database_probe_create_and_attach_have_deadlines(self):
        for stage in ("exec", "create", "start-attached"):
            with self.subTest(stage=stage):
                self.env["STALL"] = stage
                self.cli(
                    "docker",
                    """case "$1" in
build) echo image ;;
network) [ "$2" = create ] && exit 0; printf "owned-id "; cat "$FIXTURE/owner" ;;
container) printf "owned-id "; cat "$FIXTURE/owner" ;;
create)
  for arg do case "$arg" in vid.check.owner=*) echo "${arg#*=}" > "$FIXTURE/owner";; esac; done
  if [ "$STALL" = create ]; then echo $$ > "$FIXTURE/client"; exec sleep 60; fi ;;
exec) if [ "$STALL" = exec ]; then echo $$ > "$FIXTURE/client"; exec sleep 60; fi ;;
start) if [ "$2" = -a ] && [ "$STALL" = start-attached ]; then echo $$ > "$FIXTURE/client"; exec sleep 60; fi ;;
esac
exit 0
""",
                )
                result = self.run_script("database-check.sh")
                self.assertNotEqual(result.returncode, 0, result.stderr)
                pid = int((self.path / "client").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_deployment_controller_bounds_stalled_cli_and_cleanup(self):
        self.cli("docker", '''case " $* " in
*" down "*) exit 0 ;;
esac
echo $$ > "$FIXTURE/client"
exec sleep 60
''')
        script = self.root / "tests/scripts/deployment-check.sh"
        try:
            result = subprocess.run(["sh", str(script)], env=self.env, check=False, capture_output=True, text=True, timeout=12)
        except subprocess.TimeoutExpired:
            os.kill(int((self.path / "client").read_text()), signal.SIGKILL)
            self.fail("Deployment CLI exceeded the controller deadline")
        self.assertEqual(result.returncode, 124, result.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.path / "client").read_text()), 0)

    def test_deployment_input_stage_terminates_owned_cli_without_waiting_for_deadline(self):
        self.cli("docker", '''case " $* " in
*" config --services "*) printf 'objects\\nstorage-init\\nworker\\n'; exit 0 ;;
*" exec -T objects "*) echo $$ > "$FIXTURE/client"; exec sleep 60 ;;
*" down "*) echo cleaned > "$FIXTURE/cleaned" ;;
esac
exit 0
''')
        self.env["VID_RUN_TIMEOUT"] = "60"
        controller = subprocess.Popen(["sh", str(self.root / "tests/scripts/deployment-check.sh")], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            while not (self.path / "client").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.path / "client").exists())
            controller.terminate()
            controller.communicate(timeout=2)
            self.assertEqual(controller.returncode, 143)
            self.assertTrue((self.path / "cleaned").exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int((self.path / "client").read_text()), 0)
        finally:
            if controller.poll() is None:
                os.killpg(controller.pid, signal.SIGKILL)
                controller.communicate()

    def test_restart_dispatch_bounds_stalled_ssh_and_reaps_it_on_term(self):
        self.cli("tar", 'while [ "$1" != -cf ]; do shift; done; printf "context\\n" > "$2"\n')
        self.cli("ssh", 'echo $$ > "$FIXTURE/client"; exec sleep 60\n')
        controller = subprocess.Popen(["sh", str(self.root / "scripts/sandbox-check.sh"), "--restart"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            while not (self.path / "client").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.path / "client").exists())
            controller.terminate()
            controller.communicate(timeout=2)
            self.assertEqual(controller.returncode, 143)
            with self.assertRaises(ProcessLookupError):
                os.kill(int((self.path / "client").read_text()), 0)
        finally:
            if controller.poll() is None:
                os.killpg(controller.pid, signal.SIGKILL)
                controller.communicate()

    def test_restart_dispatch_times_out_stalled_ssh_before_native_seed(self):
        self.cli("tar", 'while [ "$1" != -cf ]; do shift; done; printf "context\\n" > "$2"\n')
        self.cli("ssh", 'echo $$ > "$FIXTURE/client"; exec sleep 60\n')
        self.env["VID_RUN_TIMEOUT"] = "1"
        result = subprocess.run(["sh", str(self.root / "scripts/sandbox-check.sh"), "--restart"], env=self.env, capture_output=True, text=True, timeout=4)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("Stage timed out: ssh", result.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.path / "client").read_text()), 0)

    def test_foreign_label_never_authorizes_removal(self):
        self.cli(
            "docker",
            """case "$1" in
build) echo image ;;
create) exit 70 ;;
container) echo foreign-id foreign-owner ;;
rm) echo removed > "$FIXTURE/removed" ;;
esac
""",
        )
        result = self.run_script("check.sh")
        self.assertEqual(result.returncode, 70)
        self.assertFalse((self.path / "removed").exists())

    def test_failed_context_receiver_does_not_start_remote_tests(self):
        self.cli(
            "tar",
            'while [ "$1" != -cf ]; do shift; done; printf "context\\n" > "$2"\n',
        )
        self.cli(
            "ssh",
            'cat > "$FIXTURE/received"; echo invoked >> "$FIXTURE/ssh-invoked"; exit 72\n',
        )
        result = self.run_script("sandbox-check.sh")
        self.assertEqual(result.returncode, 72, result.stderr)
        self.assertEqual((self.path / "received").read_bytes(), b"context\n")
        self.assertEqual((self.path / "ssh-invoked").read_text(), "invoked\n")

    def test_failed_context_producer_does_not_start_remote_tests(self):
        self.cli("tar", "exit 71\n")
        self.cli("ssh", 'cat >/dev/null; echo invoked >> "$FIXTURE/ssh-invoked"\n')
        result = self.run_script("sandbox-check.sh")
        self.assertEqual(result.returncode, 71, result.stderr)
        self.assertFalse(
            (self.path / "ssh-invoked").exists(), "Failed source context was transferred"
        )

    def remote_fixture(self):
        # Run only the remote shell lifecycle with CLI fault fixtures, never a VM.
        remote = (
            (self.root / "scripts/sandbox-check.sh")
            .read_text()
            .split("<<'REMOTE'\n", 1)[1]
            .rsplit("\nREMOTE", 1)[0]
        )
        script = self.path / "remote.sh"
        script.write_text(remote)
        (self.path / "e2b").mkdir()
        self.env["HOME"] = str(self.path)
        self.cli("sudo", 'exec "$@"\n')
        self.cli(
            "timeout", 'while [ "${1#--}" != "$1" ]; do shift; done; shift; exec "$@"\n'
        )
        self.cli("flock", "exit 0\n")
        self.cli("ip", 'echo "$*" >> "$FIXTURE/ip-log"; [ "$1 $2" != "addr del" ]\n')
        self.cli("iptables", 'echo "$*" >> "$FIXTURE/rules"\n')
        self.cli(
            "docker",
            """case "$1" in
cp) echo local-key > "$3" ;;
inspect) echo owned-id owned-runner ;;
start) if [ "${REMOTE_STALL:-0}" = 1 ]; then echo $$ > "$FIXTURE/remote-client"; exec sleep 60; fi ;;
rm) echo removed > "$FIXTURE/removed" ;;
esac
exit 0
""",
        )
        return script

    def test_failed_remote_alias_deletion_retains_management_guard(self):
        script = self.remote_fixture()
        result = subprocess.run(
            ["sh", str(script), "image", "owned-runner"],
            env=self.env,
            check=False,
            capture_output=True,
            text=True,
            timeout=12,
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        rules = (self.path / "rules").read_text()
        self.assertIn("-D INPUT -d 203.0.113.254 -p tcp", rules)
        self.assertNotIn("-D INPUT -d 203.0.113.254 -m conntrack", rules)
        self.assertFalse((self.path / "e2b/.owned-runner/key.env").exists())
        self.assertTrue((self.path / "removed").exists())

    def test_remote_term_removes_runner_and_reaps_attached_client(self):
        script = self.remote_fixture()
        self.env["REMOTE_STALL"] = "1"
        proc = subprocess.Popen(
            ["sh", str(script), "image", "owned-runner"],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.monotonic() + 5
        while (
            not (self.path / "remote-client").exists() and time.monotonic() < deadline
        ):
            time.sleep(0.05)
        pid = int((self.path / "remote-client").read_text())
        key = self.path / "e2b/.owned-runner/key.env"
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)
        proc.send_signal(signal.SIGTERM)
        self.assertEqual(proc.wait(timeout=10), 143)
        self.assertTrue((self.path / "removed").exists())
        self.assertFalse(key.exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_term_reaps_owned_ssh(self):
        self.cli(
            "docker",
            'case "$1" in build) echo image;; save) echo archive > "$3";; esac\n',
        )
        self.cli("ssh", 'echo $$ > "$FIXTURE/client"; exec sleep 60\n')
        proc = subprocess.Popen(
            ["sh", str(self.root / "scripts/sandbox-check.sh")],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        deadline = time.monotonic() + 5
        while not (self.path / "client").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        pid = int((self.path / "client").read_text())
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        os.kill(pid, signal.SIGKILL)
        self.fail("Owned SSH client survived local TERM")


if __name__ == "__main__":
    unittest.main()
