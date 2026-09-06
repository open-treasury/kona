data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "inference_execution" {
  name               = "${var.name_prefix}-inference-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "grader_execution" {
  name               = "${var.name_prefix}-grader-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "inference_task" {
  name               = "${var.name_prefix}-inference-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "kona_inference_task" {
  name               = "${var.name_prefix}-kona-inference-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "grader_task" {
  name               = "${var.name_prefix}-grader-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "prepare_task" {
  name               = "${var.name_prefix}-prepare-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "states" {
  name               = "${var.name_prefix}-states"
  assume_role_policy = data.aws_iam_policy_document.states_assume.json
}

data "aws_iam_policy_document" "inference_execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.inference.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.inference.arn}:*"]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.azure_secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.azure_secret_kms_key_arn]
  }
}

data "aws_iam_policy_document" "grader_execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.grader.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.grader.arn}:*"]
  }
}

data "aws_iam_policy_document" "inference_task" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/requests/v1/runs/${var.active_run_id}/inference/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/workspaces/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/claims/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/inference/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/patches/*"]
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/claims/model-attempt-1.json"]
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.artifact_kms_key_arn]
  }
}

data "aws_iam_policy_document" "grader_task" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/requests/v1/runs/${var.active_run_id}/grader/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/patches/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/claims/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/grader/*"]
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.artifact_kms_key_arn]
  }
}

data "aws_iam_policy_document" "prepare_task" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/requests/v1/runs/${var.active_run_id}/prepare/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/prepared/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/workspaces/*", "arn:aws:s3:::${var.artifact_bucket}/staging/v1/runs/${var.active_run_id}/tasks/*/claims/*"]
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.artifact_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "inference_execution" {
  role   = aws_iam_role.inference_execution.id
  policy = data.aws_iam_policy_document.inference_execution.json
}
resource "aws_iam_role_policy" "grader_execution" {
  role   = aws_iam_role.grader_execution.id
  policy = data.aws_iam_policy_document.grader_execution.json
}
resource "aws_iam_role_policy" "inference_task" {
  for_each = {
    pure = aws_iam_role.inference_task.id
    kona = aws_iam_role.kona_inference_task.id
  }
  role   = each.value
  policy = data.aws_iam_policy_document.inference_task.json
}

data "aws_iam_policy_document" "kona_bundle" {
  count = var.kona_bundle_sha256 == null ? 0 : 1
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/bundles/${var.kona_bundle_sha256}.tar.gz"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.artifact_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "kona_bundle" {
  count  = var.kona_bundle_sha256 == null ? 0 : 1
  role   = aws_iam_role.kona_inference_task.id
  policy = data.aws_iam_policy_document.kona_bundle[0].json
}
resource "aws_iam_role_policy" "grader_task" {
  role   = aws_iam_role.grader_task.id
  policy = data.aws_iam_policy_document.grader_task.json
}
resource "aws_iam_role_policy" "prepare_task" {
  role   = aws_iam_role.prepare_task.id
  policy = data.aws_iam_policy_document.prepare_task.json
}

data "aws_iam_policy_document" "states" {
  statement {
    actions = ["ecs:RunTask"]
    resources = concat(
      [for task in aws_ecs_task_definition.inference : task.arn],
      [for task in aws_ecs_task_definition.grader : task.arn],
      [for task in aws_ecs_task_definition.prepare : task.arn],
    )
  }
  statement {
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.inference_execution.arn, aws_iam_role.grader_execution.arn, aws_iam_role.inference_task.arn, aws_iam_role.kona_inference_task.arn, aws_iam_role.grader_task.arn, aws_iam_role.prepare_task.arn]
  }
  statement {
    actions   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
    resources = ["arn:aws:events:${var.aws_region}:*:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
  statement {
    actions   = ["states:StartExecution", "states:DescribeExecution"]
    resources = ["*"]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}/orchestration/*", "arn:aws:s3:::${var.artifact_bucket}/requests/*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.artifact_kms_key_arn]
  }
  statement {
    actions   = ["kms:Verify"]
    resources = [aws_kms_key.probe_approval.arn]
  }
}

data "aws_iam_policy_document" "launcher" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.eval.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.artifact_bucket}", "arn:aws:s3:::${var.artifact_bucket}/requests/*", "arn:aws:s3:::${var.artifact_bucket}/orchestration/*", "arn:aws:s3:::${var.artifact_bucket}/staging/*"]
  }
}

data "aws_iam_policy_document" "approver" {
  statement {
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = [aws_kms_key.probe_approval.arn]
  }
}

resource "aws_iam_policy" "launcher" {
  name   = "${var.name_prefix}-launcher"
  policy = data.aws_iam_policy_document.launcher.json
}

resource "aws_iam_policy" "approver" {
  name   = "${var.name_prefix}-approver"
  policy = data.aws_iam_policy_document.approver.json
}

resource "aws_iam_role_policy" "states" {
  role   = aws_iam_role.states.id
  policy = data.aws_iam_policy_document.states.json
}
