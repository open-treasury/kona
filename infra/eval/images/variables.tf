variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "name_prefix" {
  type    = string
  default = "kona-eval"
}
variable "artifact_bucket" { type = string }
variable "artifact_kms_key_arn" { type = string }
variable "source_object_key" {
  type    = string
  default = "build/source.zip"
}
variable "tags" {
  type    = map(string)
  default = { Project = "kona", System = "evaluation" }
}
