resource "aws_ecr_repository" "inference" {
  name                 = "${var.name_prefix}/inference"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "grader" {
  name                 = "${var.name_prefix}/grader"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_cloudwatch_log_group" "build" {
  name              = "/${var.name_prefix}/image-build"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "build" {
  name               = "${var.name_prefix}-image-build"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "build" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"]
    resources = [aws_ecr_repository.inference.arn, aws_ecr_repository.grader.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/${var.source_object_key}", "arn:aws:s3:::${var.artifact_bucket}/build/results/*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.artifact_kms_key_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.build.arn}:*"]
  }
}

resource "aws_iam_role_policy" "build" {
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}

resource "aws_codebuild_project" "images" {
  name         = "${var.name_prefix}-images"
  service_role = aws_iam_role.build.arn

  source {
    type      = "S3"
    location  = "${var.artifact_bucket}/${var.source_object_key}"
    buildspec = <<-YAML
      version: 0.2
      phases:
        pre_build:
          commands:
            - aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com"
            - docker buildx create --use --name kona-builder
        build:
          commands:
            - python3 eval/featurebench/images/build_images.py
        post_build:
          commands:
            - KEY=$(printf '%s' "$IMAGE_FAMILY" | sha256sum | cut -c1-12)
            - test ! -f eval/featurebench/manifests/derived-images.lock.json || aws s3 cp eval/featurebench/manifests/derived-images.lock.json "s3://$ARTIFACT_BUCKET/build/results/$KEY.json" --sse aws:kms --sse-kms-key-id "$ARTIFACT_KMS_KEY_ARN"
    YAML
  }

  artifacts { type = "NO_ARTIFACTS" }

  environment {
    compute_type                = "BUILD_GENERAL1_LARGE"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"
    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = data.aws_caller_identity.current.account_id
    }
    environment_variable {
      name  = "ARTIFACT_BUCKET"
      value = var.artifact_bucket
    }
    environment_variable {
      name  = "ARTIFACT_KMS_KEY_ARN"
      value = var.artifact_kms_key_arn
    }
    environment_variable {
      name  = "INFERENCE_REPOSITORY"
      value = aws_ecr_repository.inference.repository_url
    }
    environment_variable {
      name  = "GRADER_REPOSITORY"
      value = aws_ecr_repository.grader.repository_url
    }
  }

  logs_config {
    cloudwatch_logs { group_name = aws_cloudwatch_log_group.build.name }
  }
}

data "aws_caller_identity" "current" {}
