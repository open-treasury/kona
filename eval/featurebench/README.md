# FeatureBench evaluator

This directory implements the development-evaluation contract in
[`specs/kona-development-evaluation/spec.md`](../../specs/kona-development-evaluation/spec.md).
It does not replace the historical Harbor rig in `eval/run/`.

## Fixed inputs

- FeatureBench `0.2.2`, source commit `3a19b110a39a13f5cd000472a2209f112219af64`
- Dataset `LiberCoders/FeatureBench` v1.1, commit
  `76b4a4566e04f4bcc13c35125d4f301791efa736`, split `fast`
- mini-swe-agent `2.4.6`
- one attempt and a 3,600-second inference timeout per task
- Linux x86-64 Fargate task images

`manifests/fast-v1.1.json` pins the 100 task IDs and 18 image families. Before deployment, resolve
each source image to an OCI digest and provide the resulting source-image lock to
`bun run eval:featurebench:images`; mutable source tags are never accepted by the build plan.

## Flow

1. Apply `infra/eval/bootstrap`, then migrate its state to the emitted S3 backend configuration.
2. Build and push the 18 inference and 18 grader images by digest.
3. Apply `infra/eval/runtime` with those image pairs and the Azure Secrets Manager ARN.
4. Use `bun run eval:featurebench -- prepare` to create separate sanitized inference and grader
   requests plus `probe.json` and `continue.json`.
5. Use `start --phase probe`; approve measured cost and quota behavior before `start --phase
continue`.
6. Download the sealed staging prefix and use `collect` to create and push the named DVC experiment.
7. Record the maintainer's decision with `decision`.

The CLI requires explicit file arguments and never discovers credentials from project files. AWS
authentication comes from the normal AWS credential chain; Azure credentials enter inference tasks
only through Secrets Manager. `dvc exp push` and `dvc exp pull` are required because ordinary Git
push/fetch does not transfer DVC experiment refs or cached artifacts.

## Local verification

```bash
bun run test:eval:featurebench
bunx tsc -p eval --noEmit
terraform -chdir=infra/eval/bootstrap init -backend=false
terraform -chdir=infra/eval/bootstrap test
terraform -chdir=infra/eval/runtime init -backend=false
terraform -chdir=infra/eval/runtime test
```

No paid run begins during these checks.
