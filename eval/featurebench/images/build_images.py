"""Build all digest-pinned FeatureBench inference and grader images in CodeBuild."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path


root = Path(__file__).resolve().parents[3]
manifest = json.loads((root / "eval/featurebench/manifests/fast-v1.1.json").read_text())
source_lock = json.loads(
    (root / "eval/featurebench/manifests/source-images.lock.json").read_text()
)
repositories = {
    "inference": os.environ["INFERENCE_REPOSITORY"],
    "grader": os.environ["GRADER_REPOSITORY"],
}
result = {"schemaVersion": 1, "platform": "linux/amd64", "images": {}}

selected = os.environ.get("IMAGE_FAMILY")
families = [selected] if selected else manifest["imageFamilies"]
for family in families:
    if family not in manifest["imageFamilies"]:
        raise RuntimeError(f"Unknown image family: {family}")
    source = source_lock["images"][family]
    build_identity = hashlib.sha256(family.encode())
    for path in sorted((root / "eval/featurebench/runtime").glob("*.py")):
        build_identity.update(path.name.encode())
        build_identity.update(path.read_bytes())
    for path in sorted((root / "eval/featurebench/images").glob("*.Dockerfile")):
        build_identity.update(path.name.encode())
        build_identity.update(path.read_bytes())
    key = build_identity.hexdigest()[:12]
    built = {"source": source}
    for kind in ("inference", "grader"):
        metadata = Path(f"/tmp/{key}-{kind}.json")
        tag = f"{repositories[kind]}:{key}"
        subprocess.run(
            [
                "docker",
                "buildx",
                "build",
                "--platform",
                "linux/amd64",
                "--build-arg",
                f"BASE_IMAGE={source}",
                "--file",
                f"eval/featurebench/images/{kind}.Dockerfile",
                "--tag",
                tag,
                "--push",
                "--metadata-file",
                str(metadata),
                ".",
            ],
            cwd=root,
            check=True,
        )
        digest = json.loads(metadata.read_text())["containerimage.digest"]
        built[kind] = f"{repositories[kind]}@{digest}"
    result["images"][family] = built

output = root / "eval/featurebench/manifests/derived-images.lock.json"
output.write_text(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
