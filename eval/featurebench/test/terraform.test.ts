import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "infra", "eval");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("Terraform evaluation infrastructure contracts", () => {
  test("pins Terraform/provider versions and uses S3-native locking", () => {
    for (const root of ["bootstrap", "runtime"]) {
      const versions = read(root, "versions.tf");
      expect(versions).toContain('required_version = "~> 1.16.0"');
      expect(versions).toContain('version = "= 6.33.0"');
    }
    expect(read("bootstrap", "backend.s3.tf.example")).toContain('backend "s3"');
    expect(read("runtime", "versions.tf")).toContain('backend "s3"');
    expect(read("bootstrap", "outputs.tf")).toContain("use_lockfile = true");
    expect(read("bootstrap", "main.tf")).not.toContain("dynamodb");
  });

  test("keeps durable buckets outside the replaceable runtime root", () => {
    const bootstrap = read("bootstrap", "main.tf");
    const runtime = read("runtime", "main.tf");
    expect(bootstrap).toContain('resource "aws_s3_bucket" "state"');
    expect(bootstrap).toContain('resource "aws_s3_bucket" "artifacts"');
    expect(bootstrap.match(/prevent_destroy = true/g)).toHaveLength(4);
    expect(runtime).not.toContain('resource "aws_s3_bucket"');
  });

  test("Fargate is direct, x86, no-ingress, and supports 20 or 50 workers", () => {
    const runtime = `${read("runtime", "variables.tf")}\n${read("runtime", "network.tf")}\n${read("runtime", "main.tf")}`;
    expect(runtime).toContain('requires_compatibilities = ["FARGATE"]');
    expect(runtime).toContain('cpu_architecture        = "X86_64"');
    expect(runtime).toContain("contains([20, 50], var.requested_concurrency)");
    expect(runtime).toContain('MaxConcurrencyPath = "$.requestedConcurrency"');
    expect(runtime).toContain('AssignPublicIp = "ENABLED"');
    expect(runtime.match(/"States.TaskFailed"/g)).toHaveLength(1);
    expect(runtime).not.toMatch(/\bingress\s*\{/);
    expect(runtime).not.toContain("privileged");
  });

  test("grader has no Azure secret and roles are separated", () => {
    const main = read("runtime", "main.tf");
    const iam = read("runtime", "iam.tf");
    const graderBlock = main.slice(main.indexOf('resource "aws_ecs_task_definition" "grader"'));
    expect(graderBlock).not.toContain("AZURE_API_KEY");
    expect(main).toContain('name = "AZURE_API_KEY"');
    expect(iam).toContain('resource "aws_iam_role" "inference_task"');
    expect(iam).toContain('resource "aws_iam_role" "grader_task"');
    expect(iam).toContain('"s3:GetObjectVersion"');
    expect(iam).toContain('variable = "s3:if-none-match"');
  });

  test("continuation verification reads the signed manifest version", () => {
    const verifier = read("runtime", "probe_verifier.py");
    expect(verifier).toContain('VersionId=authorization["manifestVersionId"]');
    expect(verifier).toContain('authorization["continuationManifestSha256"]');
  });
});
