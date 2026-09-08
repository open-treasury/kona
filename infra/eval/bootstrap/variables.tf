variable "aws_region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "The initial evaluation deployment is fixed to us-east-1."
  }
}

variable "name_prefix" {
  type    = string
  default = "kona-eval"
}

variable "staging_retention_days" {
  type    = number
  default = 30

  validation {
    condition     = var.staging_retention_days >= 7
    error_message = "Staging artifacts must be retained for at least seven days."
  }
}

variable "tags" {
  type = map(string)
  default = {
    Project = "kona"
    System  = "evaluation"
  }
}
