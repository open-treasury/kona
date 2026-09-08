mock_provider "aws" {}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

run "durable_resources" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "kona-eval-tfstate-123456789012"
    error_message = "State bucket must be deterministic for the AWS account."
  }

  assert {
    condition     = aws_s3_bucket.artifacts.bucket == "kona-eval-artifacts-123456789012"
    error_message = "Artifact bucket must be deterministic for the AWS account."
  }

  assert {
    condition     = output.backend_config.use_lockfile
    error_message = "The S3 backend must use native lock files."
  }
}
