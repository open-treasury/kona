output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.id
}

output "artifact_kms_key_arn" {
  value = aws_kms_key.artifacts.arn
}

output "backend_config" {
  value = {
    bucket       = aws_s3_bucket.state.id
    key          = "states/bootstrap/terraform.tfstate"
    region       = var.aws_region
    encrypt      = true
    kms_key_id   = aws_kms_key.state.arn
    use_lockfile = true
  }
}
