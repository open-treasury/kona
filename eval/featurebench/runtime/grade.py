"""Grade one FeatureBench patch inside a grader-only Fargate task image."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from common import LocalTransport, atomic_json, redact


def _validate_native_result(
    raw: dict[str, Any],
    f2p_map: dict[str, str],
    p2p_maps: list[dict[str, str]],
    expected_p2p: int,
) -> None:
    if raw.get("error"):
        raise RuntimeError(f"FeatureBench native grader failed: {raw['error']}")
    if not raw.get("patch_applied"):
        raise RuntimeError("FeatureBench native grader did not apply the patch")
    if not f2p_map:
        raise RuntimeError("FeatureBench native grader produced no F2P test results")
    if len(p2p_maps) != expected_p2p or any(not result for result in p2p_maps):
        raise RuntimeError(
            "FeatureBench native grader produced incomplete P2P test results"
        )


def run(request_path: Path, output_dir: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if "AZURE_API_KEY" in __import__("os").environ:
        raise RuntimeError("grader isolation failed: Azure credential is present")
    row = request["task"]
    required = {
        "instance_id",
        "repo",
        "level",
        "patch",
        "test_patch",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "repo_settings",
    }
    missing = required.difference(row)
    if missing:
        raise ValueError(f"grader row is missing fields: {sorted(missing)}")
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result: dict[str, Any] = {
        "schema_version": 1,
        "instance_id": row["instance_id"],
        "attempt": 1,
        "status": "failed",
        "failure": None,
        "patch_sha256": request.get("patch_sha256"),
    }
    try:
        pd = importlib.import_module("pandas")
        native_runtime = importlib.import_module("featurebench.harness.runtime")
        constants = importlib.import_module("featurebench.harness.constants")
        report_module = importlib.import_module("featurebench.harness.report")
        EvalType = getattr(constants, "EvalType")
        FAIL_ONLY_REPOS = getattr(constants, "FAIL_ONLY_REPOS")
        build_test_status = getattr(report_module, "build_test_status")
        generate_instance_report = getattr(report_module, "generate_instance_report")
        parse_test_outputs = getattr(report_module, "parse_test_outputs")
        save_report = getattr(report_module, "save_report")

        transport = LocalTransport()

        def local_exec(
            _container: object,
            command: str,
            timeout: int | None = None,
            **_kwargs: object,
        ) -> tuple[int, bytes]:
            code, output = transport.exec_command(None, command, timeout=timeout)
            return code, output.encode()

        setattr(native_runtime, "exec_run_with_timeout", local_exec)
        setattr(native_runtime, "copy_to_container", transport.copy_to_container)
        instance = pd.Series(row)
        prediction = {
            "instance_id": row["instance_id"],
            "n_attempt": 1,
            "model_patch": request["patch"],
        }
        logger = logging.getLogger(f"kona-featurebench-grader-{row['instance_id']}")
        logger.addHandler(
            logging.FileHandler(output_dir / "run_instance.log", encoding="utf-8")
        )
        if int(row["level"]) == 1:
            raw = native_runtime.run_instance_level1(
                instance,
                prediction,
                None,
                logger,
                output_dir,
                timeout=request.get("timeout"),
                white=False,
            )
        else:
            raw = native_runtime.run_instance_level2(
                instance,
                prediction,
                None,
                logger,
                output_dir,
                timeout=request.get("timeout"),
            )
        f2p_map, p2p_maps = parse_test_outputs(
            output_dir, row["repo"], int(row["level"])
        )
        eval_type = (
            EvalType.FAIL_ONLY
            if row["repo"] in FAIL_ONLY_REPOS
            else EvalType.PASS_AND_FAIL
        )
        expected_p2p = (
            len(row["PASS_TO_PASS"])
            if int(row["level"]) == 1 and eval_type != EvalType.FAIL_ONLY
            else 0
        )
        _validate_native_result(raw, f2p_map, p2p_maps, expected_p2p)
        f2p_ok, f2p_bad, p2p_ok, p2p_bad = build_test_status(
            f2p_map, p2p_maps, eval_type
        )
        report = generate_instance_report(
            row["instance_id"],
            1,
            request["patch"],
            raw["patch_applied"],
            f2p_ok,
            f2p_bad,
            p2p_ok,
            p2p_bad,
            raw,
        )
        save_report(report, output_dir)
        item = report[row["instance_id"]]
        result.update(
            {
                "status": "completed",
                "passed": len(f2p_ok),
                "total": len(f2p_ok) + len(f2p_bad),
                "resolved": bool(item["resolved"]),
                "native_report": item,
            }
        )
    except Exception as error:
        result["failure"] = {
            "class": "GRADER",
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
        _validate_native_result(
            {"patch_applied": True, "error": None}, {"test": "PASSED"}, [], 0
        )
        for raw, f2p, p2p, expected_p2p in [
            ({"patch_applied": False, "error": None}, {"test": "FAILED"}, [], 0),
            ({"patch_applied": True, "error": "test failed to run"}, {}, [], 0),
            ({"patch_applied": True, "error": None}, {}, [], 0),
            ({"patch_applied": True, "error": None}, {"test": "PASSED"}, [], 1),
        ]:
            try:
                _validate_native_result(raw, f2p, p2p, expected_p2p)
            except RuntimeError:
                continue
            raise AssertionError("invalid native grade was accepted")
        return 0
    if args.request is None or args.output_dir is None:
        parser.error("--request and --output-dir are required")
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    sys.exit(main())
