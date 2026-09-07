"""S3 boundary and at-most-once claim wrapper for direct Fargate workers."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import hashlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
from pathlib import Path

from common import atomic_json


def _s3():
    boto3 = importlib.import_module("boto3")
    return boto3.client("s3")


def _uri(value: str) -> tuple[str, str]:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path.lstrip("/"):
        raise ValueError("request URI must be s3://bucket/key")
    return parsed.netloc, parsed.path.lstrip("/")


def _task_identity(phase: str) -> tuple[str, str]:
    declared = os.environ.get("PRODUCER_IMAGE_DIGEST", "")
    metadata = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not metadata:
        return "local", declared.rsplit("@", 1)[-1]
    import urllib.request

    with urllib.request.urlopen(f"{metadata}/task", timeout=5) as response:
        payload = json.load(response)
    container_name = {"prepare": "prepare", "infer": "inference", "grade": "grader"}[
        phase
    ]
    container = next(
        (
            item
            for item in payload.get("Containers", [])
            if item.get("Name") == container_name
        ),
        None,
    )
    observed = container.get("ImageID") if container else None
    expected = declared.rsplit("@", 1)[-1]
    if not observed or observed != expected:
        raise RuntimeError(
            "running container image digest does not match task definition"
        )
    return str(payload["TaskARN"]), observed


def _download_json(uri: str) -> tuple[dict, str, str]:
    bucket, key = _uri(uri)
    response = _s3().get_object(Bucket=bucket, Key=key)
    return json.loads(response["Body"].read()), bucket, key


def _publish_directory(bucket: str, prefix: str, directory: Path) -> dict:
    client = _s3()
    files = {}
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        relative = path.relative_to(directory).as_posix()
        body = path.read_bytes()
        key = f"{prefix.rstrip('/')}/{relative}"
        client.put_object(Bucket=bucket, Key=key, Body=body, IfNoneMatch="*")
        files[relative] = {
            "sha256": hashlib.sha256(body).hexdigest(),
            "bytes": len(body),
        }
    return files


def _publish_manifest(
    bucket: str,
    prefix: str,
    request: dict,
    phase: str,
    invocation_id: str,
    observed_image_digest: str,
    files: dict,
) -> None:
    manifest = {
        "schema_version": 1,
        "epoch_sha256": request["epoch_sha256"],
        "run_id": request["run_id"],
        "task_id": request["task"]["instance_id"],
        "image_name": request["task"]["image_name"],
        "attempt": 1,
        "phase": phase,
        "invocation_id": invocation_id,
        "ecs_task_arn": os.environ.get("ECS_TASK_ARN", invocation_id),
        "producer_image_digest": os.environ.get("PRODUCER_IMAGE_DIGEST"),
        "observed_image_digest": observed_image_digest,
        "files": files,
    }
    _s3().put_object(
        Bucket=bucket,
        Key=f"{prefix.rstrip('/')}/manifest.json",
        Body=(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode(),
        ContentType="application/json",
        IfNoneMatch="*",
    )


def _claim(bucket: str, key: str, invocation_id: str) -> None:
    body = json.dumps(
        {"schema_version": 1, "invocation_id": invocation_id}, sort_keys=True
    ).encode()
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        IfNoneMatch="*",
    )


def _install_kona(request: dict, bucket: str, root: Path) -> None:
    kona = request.get("kona")
    if kona is None:
        return
    expected = kona["bundleSha256"]
    archive = root / "kona-bundle.tar.gz"
    key = f"bundles/{expected}.tar.gz"
    archive.write_bytes(_s3().get_object(Bucket=bucket, Key=key)["Body"].read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise RuntimeError("Kona bundle hash mismatch")
    extracted = root / "kona-bundle"
    extracted.mkdir()
    with tarfile.open(archive, "r:gz") as source:
        source.extractall(extracted, filter="data")
    binaries = [extracted / "bin" / "kona", extracted / "kona-linux-x64"]
    binary = next((candidate for candidate in binaries if candidate.is_file()), None)
    skill = extracted / "skills" / "kona"
    config = extracted / "config.json"
    seed = skill / "seed.json"
    hooks = extracted / "hooks"
    if (
        binary is None
        or not skill.is_dir()
        or not config.is_file()
        or not seed.is_file()
        or not hooks.is_dir()
    ):
        raise RuntimeError(
            "Kona bundle is missing binary, skill, config, seed, or hooks"
        )

    def tree_hash(path: Path) -> str:
        digest = hashlib.sha256()
        for item in sorted(
            candidate for candidate in path.rglob("*") if candidate.is_file()
        ):
            digest.update(item.relative_to(path).as_posix().encode())
            digest.update(b"\0")
            digest.update(item.read_bytes())
            digest.update(b"\0")
        return digest.hexdigest()

    actual = {
        "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "instructionSha256": hashlib.sha256(
            (skill / "SKILL.md").read_bytes()
        ).hexdigest(),
        "configSha256": hashlib.sha256(config.read_bytes()).hexdigest(),
        "seedSha256": hashlib.sha256(seed.read_bytes()).hexdigest(),
        "hooksSha256": tree_hash(hooks),
    }
    for name, observed in actual.items():
        if kona.get(name) != observed:
            raise RuntimeError(f"Kona {name} mismatch")
    Path("/usr/local/bin").mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, "/usr/local/bin/kona")
    os.chmod("/usr/local/bin/kona", 0o755)
    target = Path("/opt/kona/skills/kona")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(skill, target)
    shutil.copy2(config, "/opt/kona/config.json")
    shutil.copytree(hooks, "/opt/kona/hooks")
    completed = subprocess.run(
        [
            "/usr/local/bin/kona",
            "init",
            "--config",
            "/opt/kona/config.json",
            "--prefix",
            "kn",
        ],
        cwd="/",
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("Kona initialization failed")
    seeded = subprocess.run(
        [
            "/usr/local/bin/kona",
            "mutate",
            "--ops",
            "/opt/kona/skills/kona/seed.json",
            "--base-version",
            "0",
            "--why",
            "Initialize the task-agnostic evaluation workflow.",
            "--reason-code",
            "MISSING_STEP",
        ],
        cwd="/",
        capture_output=True,
        text=True,
        check=False,
    )
    if seeded.returncode != 0:
        raise RuntimeError("Kona seed failed")
    verified = subprocess.run(
        ["/usr/local/bin/kona", "next", "--json"],
        cwd="/",
        capture_output=True,
        text=True,
        check=False,
    )
    if verified.returncode != 0:
        raise RuntimeError("Kona operational verification failed")
    try:
        frontier = json.loads(verified.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Kona verification returned invalid JSON") from error
    if not isinstance(frontier.get("nodes"), list) or not frontier["nodes"]:
        raise RuntimeError("Kona seed produced no ready work")


def _restore_workspace(archive: Path, root: Path = Path("/")) -> None:
    testbed = root / "testbed"
    shutil.rmtree(testbed, ignore_errors=True)
    with tarfile.open(archive, "r:gz") as source:
        source.extractall(root, filter="data")
    if not (testbed / ".git").is_dir():
        raise RuntimeError("prepared workspace has no Git baseline")


def run(phase: str, request_uri: str) -> int:
    request, bucket, _ = _download_json(request_uri)
    task_arn, observed_image_digest = _task_identity(phase)
    invocation_id = task_arn.rsplit("/", 1)[-1]
    os.environ["ECS_TASK_ARN"] = task_arn
    with tempfile.TemporaryDirectory(prefix="kona-featurebench-") as raw:
        root = Path(raw)
        request_path = root / "request.json"
        output = root / "output"
        _install_kona(request, bucket, root)
        atomic_json(request_path, request)
        if phase == "prepare":
            script = Path(__file__).with_name("prepare.py")
        elif phase == "infer":
            claim = _s3().get_object(Bucket=bucket, Key=request["prepared_claim_key"])
            preparation_id = json.loads(claim["Body"].read())["invocation_id"]
            workspace_key = request["prepared_claim_key"].replace(
                "/claims/workspace-preparation.json",
                f"/workspaces/{preparation_id}/workspace.tar.gz",
            )
            workspace = root / "workspace.tar.gz"
            workspace.write_bytes(
                _s3().get_object(Bucket=bucket, Key=workspace_key)["Body"].read()
            )
            _restore_workspace(workspace)
            _claim(bucket, request["model_claim_key"], invocation_id)
            script = Path(__file__).with_name("infer.py")
        elif phase == "grade":
            claim = _s3().get_object(Bucket=bucket, Key=request["inference_claim_key"])
            inference_id = json.loads(claim["Body"].read())["invocation_id"]
            patch_key = request["inference_claim_key"].replace(
                "/claims/model-attempt-1.json", f"/patches/{inference_id}/patch.diff"
            )
            patch = _s3().get_object(Bucket=bucket, Key=patch_key)["Body"].read()
            request["patch"] = patch.decode()
            request["patch_sha256"] = hashlib.sha256(patch).hexdigest()
            atomic_json(request_path, request)
            script = Path(__file__).with_name("grade.py")
        else:
            raise ValueError("phase must be infer or grade")
        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                "--request",
                str(request_path),
                "--output-dir",
                str(output),
            ],
            check=False,
        )
        output_prefix = f"{request['output_prefix'].rstrip('/')}/{invocation_id}"
        files = _publish_directory(bucket, output_prefix, output)
        if phase == "prepare" and completed.returncode != 0:
            return completed.returncode
        if (
            phase == "prepare"
            and completed.returncode == 0
            and (output / "workspace.tar.gz").is_file()
        ):
            workspace_prefix = request["output_prefix"].replace(
                "/prepared", "/workspaces"
            )
            _s3().put_object(
                Bucket=bucket,
                Key=f"{workspace_prefix}/{invocation_id}/workspace.tar.gz",
                Body=(output / "workspace.tar.gz").read_bytes(),
                IfNoneMatch="*",
            )
        if phase == "infer" and (output / "patch.diff").is_file():
            patch_prefix = request["output_prefix"].replace("/inference", "/patches")
            _s3().put_object(
                Bucket=bucket,
                Key=f"{patch_prefix}/{invocation_id}/patch.diff",
                Body=(output / "patch.diff").read_bytes(),
                IfNoneMatch="*",
            )
        _publish_manifest(
            bucket,
            output_prefix,
            request,
            phase,
            invocation_id,
            observed_image_digest,
            files,
        )
        if phase == "prepare" and completed.returncode == 0:
            claim_key = request["output_prefix"].replace(
                "/prepared", "/claims/workspace-preparation.json"
            )
            _claim(bucket, claim_key, invocation_id)
        return completed.returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", nargs="?", choices=["prepare", "infer", "grade"])
    parser.add_argument("request_uri", nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        with tempfile.TemporaryDirectory(prefix="kona-workspace-test-") as raw:
            root = Path(raw)
            source = root / "source" / "testbed"
            (source / ".git").mkdir(parents=True)
            (source / "kept.py").write_text("kept\n", encoding="utf-8")
            archive = root / "workspace.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                target.add(source, arcname="testbed")
            destination = root / "destination"
            (destination / "testbed").mkdir(parents=True)
            (destination / "testbed" / "hidden_test.py").write_text(
                "must disappear\n", encoding="utf-8"
            )
            _restore_workspace(archive, destination)
            assert (destination / "testbed" / "kept.py").is_file()
            assert not (destination / "testbed" / "hidden_test.py").exists()
        return 0
    if args.phase is None or args.request_uri is None:
        parser.error("phase and request_uri are required")
    return run(args.phase, args.request_uri)


if __name__ == "__main__":
    sys.exit(main())
