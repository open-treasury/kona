variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "The initial evaluator is fixed to us-east-1."
  }
}

variable "name_prefix" {
  type    = string
  default = "kona-eval"
}
variable "active_run_id" {
  description = "Exact epoch-and-arm run ID authorized by this runtime deployment."
  type        = string
  validation {
    condition     = can(regex("^fb11-fast-[a-f0-9]{16}--(?:pure-gpt|kona-[a-f0-9]{12})$", var.active_run_id))
    error_message = "active_run_id must be a canonical FeatureBench arm ID."
  }
}
variable "kona_bundle_sha256" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition     = var.kona_bundle_sha256 == null || can(regex("^[a-f0-9]{64}$", var.kona_bundle_sha256))
    error_message = "kona_bundle_sha256 must be null or a lowercase SHA-256."
  }
}
variable "artifact_bucket" { type = string }
variable "artifact_kms_key_arn" { type = string }
variable "azure_secret_arn" {
  type      = string
  sensitive = true
}
variable "azure_secret_kms_key_arn" {
  type = string
}
variable "azure_api_base" { type = string }
variable "azure_api_version" {
  type    = string
  default = "v1"
}

variable "requested_concurrency" {
  type    = number
  default = 20
  validation {
    condition     = contains([20, 50], var.requested_concurrency)
    error_message = "requested_concurrency must be 20 or 50."
  }
}

variable "inference_cpu" {
  type    = number
  default = 2048
}
variable "inference_memory" {
  type    = number
  default = 4096
}
variable "grader_cpu" {
  type    = number
  default = 2048
}
variable "grader_memory" {
  type    = number
  default = 4096
}
variable "ephemeral_storage_gib" {
  type    = number
  default = 50
}
variable "log_retention_days" {
  type    = number
  default = 30
}

variable "image_pairs" {
  description = "Map from stable image-family key to digest-pinned inference and grader ECR image URIs."
  type = map(object({
    inference = string
    grader    = string
  }))
  validation {
    condition = length(var.image_pairs) == 18 && alltrue(flatten([
      for pair in values(var.image_pairs) : [
        can(regex("@sha256:[a-f0-9]{64}$", pair.inference)),
        can(regex("@sha256:[a-f0-9]{64}$", pair.grader)),
      ]
    ]))
    error_message = "image_pairs must contain 18 digest-pinned inference/grader image pairs."
  }
}

variable "tags" {
  type = map(string)
  default = {
    Project = "kona"
    System  = "evaluation"
  }
}
