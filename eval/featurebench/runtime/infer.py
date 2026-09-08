"""Run one FeatureBench mini-swe-agent attempt inside its Fargate task image."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from common import (
    LocalTransport,
    atomic_json,
    redact,
    sha256_file,
    validate_inference_row,
)


def _usage(node: Any) -> dict[str, int | float | None]:
    totals: dict[str, int | float | None] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_input_tokens": 0,
        "cache_write_tokens": 0,
        "cost_usd": 0.0,
    }
    found_cost = False

    def visit(value: Any) -> None:
        nonlocal found_cost
        if isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, dict):
            usage = value.get("usage")
            if isinstance(usage, dict):
                for source, target in (
                    ("prompt_tokens", "input_tokens"),
                    ("completion_tokens", "output_tokens"),
                    ("input_tokens", "input_tokens"),
                    ("output_tokens", "output_tokens"),
                    ("cached_tokens", "cached_input_tokens"),
                    ("cache_creation_input_tokens", "cache_write_tokens"),
                ):
                    amount = usage.get(source)
                    if isinstance(amount, int):
                        totals[target] = int(totals[target] or 0) + amount
            cost = value.get("cost")
            if isinstance(cost, (int, float)):
                totals["cost_usd"] = float(totals["cost_usd"] or 0) + float(cost)
                found_cost = True
            for child in value.values():
                visit(child)

    visit(node)
    if not found_cost:
        totals["cost_usd"] = None
    return totals


def _validate_arm(arm_type: str) -> str:
    kona_root = Path("/opt/kona")
    kona_binary = shutil.which("kona")
    if arm_type == "pure-gpt":
        if (
            kona_root.exists()
            or kona_binary is not None
            or any(key.startswith("KONA_") for key in os.environ)
        ):
            raise RuntimeError("pure-gpt isolation failed: Kona surface is present")
        return ""
    if arm_type != "kona":
        raise ValueError("arm type must be pure-gpt or kona")
    skill = kona_root / "skills" / "kona" / "SKILL.md"
    if kona_binary is None or not skill.is_file():
        raise RuntimeError("Kona arm is missing its binary or skill")
    return "\n\nBefore your first command, read /opt/kona/skills/kona/SKILL.md and follow it."


def _trajectory_succeeded(trajectory: dict[str, Any]) -> bool:
    return trajectory.get("info", {}).get("exit_status") == "Submitted"


def _with_model_settings(
    command: str, effort: str, cost_limit_usd: float, token_limit: int
) -> str:
    if effort not in {"low", "medium", "high", "xhigh"}:
        raise ValueError("unsupported model reasoning effort")
    if not 0 < cost_limit_usd < 1000:
        raise ValueError("model cost limit must be between zero and 1000 USD")
    if token_limit < 1:
        raise ValueError("model token limit must be positive")
    marker = " -m "
    if marker not in command:
        raise RuntimeError("mini-swe-agent command has no model marker")
    options = (
        " -c mini.yaml"
        " -c model.model_class=litellm_response"
        " -c model.model_kwargs.drop_params=true"
        f" -c model.model_kwargs.reasoning.effort={effort}"
        f" -c model.model_kwargs.max_output_tokens={token_limit}"
        f" -l {cost_limit_usd}"
    )
    return command.replace(marker, f"{options}{marker}", 1)


def run(request_path: Path, output_dir: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    row = request["task"]
    validate_inference_row(row)
    arm_type = request["arm_type"]
    directive = _validate_arm(arm_type)
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / "infer.log"
    started = time.monotonic()
    result: dict[str, Any] = {
        "schema_version": 1,
        "instance_id": row["instance_id"],
        "attempt": 1,
        "status": "failed",
        "patch_sha256": None,
        "failure": None,
    }
    try:
        MiniSweAgent = getattr(
            importlib.import_module("featurebench.infer.agents.mini_swe_agent"),
            "MiniSweAgent",
        )
        instance_id = row["instance_id"]
        logger = logging.getLogger(f"kona-featurebench-{instance_id}")
        logger.addHandler(logging.FileHandler(log_path, encoding="utf-8"))
        transport = LocalTransport()
        request_path.unlink(missing_ok=True)
        env = {
            "MSWEA_API_KEY": os.environ["AZURE_API_KEY"],
            "MSWEA_BASE_URL": os.environ["AZURE_API_BASE"],
            "AZURE_API_VERSION": os.environ.get("AZURE_API_VERSION", "v1"),
            "MINI_SWE_AGENT_VERSION": "2.4.6",
            "MSWEA_COST_TRACKING": "ignore_errors",
        }
        agent = MiniSweAgent(
            transport,
            env_vars=env,
            logger=logger,
            model=request["model"],
            version="2.4.6",
        )
        native_command = agent.get_run_command
        setattr(
            agent,
            "get_run_command",
            lambda instruction: _with_model_settings(
                native_command(instruction),
                request["model_reasoning_effort"],
                float(request["model_cost_limit_usd"]),
                int(request["model_token_limit"]),
            ),
        )
        installed = Path("/opt/mini-swe-agent-venv/bin/python").is_file()
        if not installed:
            raise RuntimeError(
                "pinned mini-swe-agent runtime is missing from the image"
            )
        Path("/installed-agent").mkdir(parents=True, exist_ok=True)
        Path("/installed-agent/setup-env.sh").write_text(
            agent.get_env_setup_script() + "\n", encoding="utf-8"
        )
        instance = type(
            "PreparedInstance",
            (),
            {
                "instance_id": instance_id,
                "level": int(str(instance_id).rsplit(".lv", 1)[-1]),
            },
        )()
        if not agent.pre_run_setup(None, instance, log_path):
            raise RuntimeError("mini-swe-agent pre-run setup failed")
        succeeded = agent.run(
            None, row["problem_statement"] + directive, log_path, timeout=3600
        )
        nested = subprocess.run(
            ["find", ".", "-type", "d", "-name", ".git", "-not", "-path", "./.git"],
            cwd="/testbed",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        for nested_git in nested:
            shutil.rmtree(Path("/testbed") / nested_git, ignore_errors=True)
        subprocess.run(["git", "add", "-A"], cwd="/testbed", check=True)
        binary = subprocess.run(
            [
                "git",
                "diff",
                "--cached",
                "--numstat",
                "--no-renames",
                "--diff-filter=ACMRTD",
            ],
            cwd="/testbed",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        for line in binary:
            added, deleted, path = line.split("\t", 2)
            if added == "-" or deleted == "-":
                subprocess.run(
                    ["git", "reset", "HEAD", "--", path], cwd="/testbed", check=False
                )
        base = subprocess.run(
            ["git", "rev-list", "--max-parents=0", "HEAD"],
            cwd="/testbed",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()[0]
        patch = None
        for _attempt in range(5):
            completed = subprocess.run(
                ["git", "diff", "--no-color", "--cached", base],
                cwd="/testbed",
                capture_output=True,
                text=True,
                check=False,
            )
            if completed.returncode == 0:
                patch = completed.stdout
                break
        if patch is None:
            raise RuntimeError(
                "FeatureBench patch extraction failed after five attempts"
            )
        patch_path = output_dir / "patch.diff"
        patch_path.write_text(patch, encoding="utf-8")
        trajectory_path = output_dir / "traj.json"
        if not trajectory_path.exists():
            raise RuntimeError("mini-swe-agent produced no trajectory")
        trajectory_data = json.loads(trajectory_path.read_text(encoding="utf-8"))
        exit_status = trajectory_data.get("info", {}).get("exit_status")
        succeeded = succeeded and _trajectory_succeeded(trajectory_data)
        usage = _usage(trajectory_data)
        result.update(
            {
                "status": "completed" if succeeded else "failed",
                "patch_sha256": sha256_file(patch_path),
                "usage": usage,
                "failure": None
                if succeeded
                else {
                    "class": "HARNESS",
                    "code": f"AGENT_{str(exit_status or 'UNKNOWN').upper()}",
                    "retryable": False,
                },
                "adoption": {
                    "instructions_loaded": arm_type == "kona",
                    "invocation_count": 0,
                    "successful_invocation_count": 0,
                    "failed_invocation_count": 0,
                    "valid_graph_produced": False,
                },
            }
        )
        if arm_type == "kona":
            trajectory = (
                trajectory_path.read_text(encoding="utf-8", errors="ignore")
                if trajectory_path.exists()
                else ""
            )
            calls = trajectory.count("kona ")
            failed_calls = trajectory.count("REFUSED ")
            result["adoption"] = {
                "instructions_loaded": "/opt/kona/skills/kona/SKILL.md" in trajectory,
                "invocation_count": calls,
                "successful_invocation_count": max(0, calls - failed_calls),
                "failed_invocation_count": failed_calls,
                "valid_graph_produced": Path("/.kona/mutations.jsonl").is_file(),
                "mutation_log_sha256": sha256_file(Path("/.kona/mutations.jsonl"))
                if Path("/.kona/mutations.jsonl").is_file()
                else None,
            }
            mutation_log = Path("/.kona/mutations.jsonl")
            if mutation_log.is_file():
                shutil.copy2(mutation_log, output_dir / "mutations.jsonl")
    except Exception as error:
        result["failure"] = {
            "class": "HARNESS",
            "code": type(error).__name__,
            "message": redact(str(error)),
            "retryable": False,
        }
    result["wall_milliseconds"] = round((time.monotonic() - started) * 1000)
    atomic_json(output_dir / "result.json", result)
    return 0 if result["status"] == "completed" else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        validate_inference_row(
            {
                "instance_id": "x",
                "problem_statement": "y",
                "image_name": "z",
                "repo_settings": "{}",
            }
        )
        command = _with_model_settings("python -m model", "xhigh", 1.0, 32768)
        assert "model.model_class=litellm_response" in command
        assert "model.model_kwargs.reasoning.effort=xhigh" in command
        assert "model.model_kwargs.max_output_tokens=32768" in command
        assert " -l 1.0" in command
        assert _trajectory_succeeded({"info": {"exit_status": "Submitted"}})
        assert not _trajectory_succeeded(
            {"info": {"exit_status": "RepeatedFormatError"}}
        )
        assert _usage({"usage": {"input_tokens": 3, "output_tokens": 2}}) == {
            "input_tokens": 3,
            "output_tokens": 2,
            "cached_input_tokens": 0,
            "cache_write_tokens": 0,
            "cost_usd": None,
        }
        return 0
    if args.request is None or args.output_dir is None:
        parser.error("--request and --output-dir are required")
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    sys.exit(main())
