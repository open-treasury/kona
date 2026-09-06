"""Prepare one hidden-test-free FeatureBench workspace before model execution."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import shutil
import sys
import tarfile
from pathlib import Path

from common import LocalTransport, atomic_json


def run(request_path: Path, output_dir: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    row = request["task"]
    TaskInstance = getattr(
        importlib.import_module("featurebench.infer.models"), "TaskInstance"
    )
    RuntimeHandler = getattr(
        importlib.import_module("featurebench.infer.runtime"), "RuntimeHandler"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    log = output_dir / "prepare.log"
    instance = TaskInstance.from_dict(row)
    logger = logging.getLogger(f"kona-featurebench-prepare-{instance.instance_id}")
    logger.addHandler(logging.FileHandler(log, encoding="utf-8"))
    if not RuntimeHandler(LocalTransport(), logger).initialize_runtime(
        None, instance, log, white_box=False
    ):
        raise RuntimeError("FeatureBench runtime preparation failed")
    request_path.unlink(missing_ok=True)
    for setup_artifact in Path("/tmp").glob("*.patch"):
        setup_artifact.unlink(missing_ok=True)
    archive = output_dir / "workspace.tar.gz"
    with tarfile.open(archive, "w:gz") as target:
        target.add(
            "/testbed",
            arcname="testbed",
            recursive=True,
            filter=lambda info: None if info.name.endswith(".pyc") else info,
        )
    atomic_json(
        output_dir / "result.json",
        {
            "schema_version": 1,
            "instance_id": row["instance_id"],
            "attempt": 1,
            "status": "completed",
        },
    )
    shutil.rmtree("/testbed", ignore_errors=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return 0
    if args.request is None or args.output_dir is None:
        parser.error("--request and --output-dir are required")
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    sys.exit(main())
