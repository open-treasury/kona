"""Shared direct-container primitives for FeatureBench Fargate workers."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


FORBIDDEN_INFERENCE_FIELDS = frozenset({"test_patch", "PASS_TO_PASS"})


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_inference_row(row: dict[str, Any]) -> None:
    exposed = FORBIDDEN_INFERENCE_FIELDS.intersection(row)
    if exposed:
        raise ValueError(f"inference row exposes grader fields: {sorted(exposed)}")
    required = {"instance_id", "problem_statement", "image_name", "repo_settings"}
    missing = required.difference(row)
    if missing:
        raise ValueError(f"inference row is missing fields: {sorted(missing)}")


class LocalTransport:
    """FeatureBench container-manager protocol implemented in the current container."""

    def __init__(self) -> None:
        self.last_stream_exit_code: int | None = None
        self.last_stream_timed_out = False

    @staticmethod
    def exec_command(
        _container: object,
        command: str,
        timeout: float | None = None,
        workdir: str | None = None,
        log_file: Path | None = None,
        **_kwargs: object,
    ) -> tuple[int, str]:
        if command == "apt-get update && apt-get install -y tmux asciinema":
            command = "command -v tmux >/dev/null && command -v asciinema >/dev/null"
        completed = subprocess.run(
            ["bash", "-lc", command],
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = completed.stdout + completed.stderr
        if log_file is not None:
            with log_file.open("a", encoding="utf-8") as target:
                target.write(output)
        return completed.returncode, output

    def exec_command_stream(
        self,
        _container: object,
        command: str,
        log_file: Path,
        timeout: float | None = None,
        workdir: str | None = None,
        skip_bashrc: bool = False,
        **_kwargs: object,
    ) -> int:
        self.last_stream_exit_code = None
        self.last_stream_timed_out = False
        shell_command = (
            command
            if skip_bashrc
            else f"source ~/.bashrc 2>/dev/null || true; {command}"
        )
        with log_file.open("a", encoding="utf-8") as target:
            process = subprocess.Popen(
                ["bash", "-lc", shell_command],
                cwd=workdir,
                stdout=target,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                self.last_stream_exit_code = process.wait(timeout=timeout)
                return self.last_stream_exit_code
            except subprocess.TimeoutExpired:
                self.last_stream_timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                target.write(f"\n[TIMEOUT after {timeout} seconds]\n")
                target.flush()
                return -1

    @staticmethod
    def copy_to_container(
        _container: object, src_path: str | Path, dest_path: str
    ) -> None:
        target = Path(dest_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, target)

    @staticmethod
    def copy_from_container(_container: object, src_path: str, dest_path: Path) -> bool:
        source = Path(src_path)
        if not source.exists():
            return False
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest_path)
        return True


def redact(message: str) -> str:
    redacted = message
    for name, value in os.environ.items():
        if value and ("KEY" in name or "TOKEN" in name or "SECRET" in name):
            redacted = redacted.replace(value, "[REDACTED]")
    return redacted


def _self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="kona-timeout-test-") as raw:
        root = Path(raw)
        marker = root / "survived"
        log = root / "process.log"
        started = time.monotonic()
        transport = LocalTransport()
        code = transport.exec_command_stream(
            None,
            f"(sleep 1; touch {marker}) & wait",
            log,
            timeout=0.1,
            skip_bashrc=True,
        )
        assert code == -1
        assert transport.last_stream_timed_out
        assert transport.last_stream_exit_code is None
        assert time.monotonic() - started < 2
        time.sleep(1.1)
        assert not marker.exists()
        assert "[TIMEOUT after 0.1 seconds]" in log.read_text(encoding="utf-8")


if __name__ == "__main__":
    if sys.argv[1:] != ["--self-test"]:
        raise SystemExit("usage: common.py --self-test")
    _self_test()
