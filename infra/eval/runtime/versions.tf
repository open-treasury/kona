terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.63.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "= 2.7.1"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = var.tags }
}
