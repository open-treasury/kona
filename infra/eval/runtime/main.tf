resource "aws_ecr_repository" "inference" {
  name                 = "${var.name_prefix}/inference"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_kms_key" "probe_approval" {
  description              = "Signs approved Kona evaluation probe evidence"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_2048"
  enable_key_rotation      = false
}

resource "aws_ecr_repository" "grader" {
  name                 = "${var.name_prefix}/grader"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_cloudwatch_log_group" "inference" {
  name              = "/${var.name_prefix}/inference"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "grader" {
  name              = "/${var.name_prefix}/grader"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "eval" { name = var.name_prefix }

locals {
  subnet_ids = aws_subnet.public[*].id
  task_environment = [
    { name = "ARTIFACT_BUCKET", value = var.artifact_bucket },
    { name = "AWS_REGION", value = var.aws_region },
  ]
}

resource "aws_ecs_task_definition" "inference" {
  for_each                 = var.image_pairs
  family                   = "${var.name_prefix}-infer-${substr(sha256(each.key), 0, 12)}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.inference_cpu
  memory                   = var.inference_memory
  execution_role_arn       = aws_iam_role.inference_execution.arn
  task_role_arn            = aws_iam_role.inference_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage { size_in_gib = var.ephemeral_storage_gib }

  container_definitions = jsonencode([{
    name      = "inference"
    image     = each.value.inference
    essential = true
    environment = concat(local.task_environment, [
      { name = "PRODUCER_IMAGE_DIGEST", value = each.value.inference },
      { name = "AZURE_API_BASE", value = var.azure_api_base },
      { name = "AZURE_API_VERSION", value = var.azure_api_version },
    ])
    secrets = [{ name = "AZURE_API_KEY", valueFrom = var.azure_secret_arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.inference.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "task"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "grader" {
  for_each                 = var.image_pairs
  family                   = "${var.name_prefix}-grade-${substr(sha256(each.key), 0, 12)}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.grader_cpu
  memory                   = var.grader_memory
  execution_role_arn       = aws_iam_role.grader_execution.arn
  task_role_arn            = aws_iam_role.grader_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage { size_in_gib = var.ephemeral_storage_gib }

  container_definitions = jsonencode([{
    name        = "grader"
    image       = each.value.grader
    essential   = true
    environment = concat(local.task_environment, [{ name = "PRODUCER_IMAGE_DIGEST", value = each.value.grader }])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.grader.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "task"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "prepare" {
  for_each                 = var.image_pairs
  family                   = "${var.name_prefix}-prepare-${substr(sha256(each.key), 0, 12)}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.grader_cpu
  memory                   = var.grader_memory
  execution_role_arn       = aws_iam_role.grader_execution.arn
  task_role_arn            = aws_iam_role.prepare_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  ephemeral_storage { size_in_gib = var.ephemeral_storage_gib }
  container_definitions = jsonencode([{
    name        = "prepare"
    image       = each.value.grader
    essential   = true
    environment = concat(local.task_environment, [{ name = "PRODUCER_IMAGE_DIGEST", value = each.value.grader }])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.grader.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "prepare"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }])
}

resource "aws_sfn_state_machine" "eval" {
  name     = var.name_prefix
  role_arn = aws_iam_role.states.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Kona FeatureBench arm"
    StartAt = "ValidateConcurrency"
    States = {
      ValidateConcurrency = {
        Type = "Choice"
        Choices = [
          { Variable = "$.requestedConcurrency", NumericEquals = 20, Next = "ValidatePhase" },
          { Variable = "$.requestedConcurrency", NumericEquals = 50, Next = "ValidatePhase" },
        ]
        Default = "InvalidConcurrency"
      }
      InvalidConcurrency = {
        Type  = "Fail"
        Error = "INVALID_CONCURRENCY"
      }
      ValidatePhase = {
        Type = "Choice"
        Choices = [
          { Variable = "$.phase", StringEquals = "probe", Next = "RunTasks" },
          {
            And = [
              { Variable = "$.phase", StringEquals = "continue" },
              { Variable = "$.probeSignature", IsPresent = true },
            ]
            Next = "VerifyProbe"
          },
        ]
        Default = "InvalidPhase"
      }
      InvalidPhase = {
        Type  = "Fail"
        Error = "PROBE_APPROVAL_REQUIRED"
      }
      VerifyProbe = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:kms:verify"
        Parameters = {
          KeyId            = aws_kms_key.probe_approval.arn
          "Message.$"      = "$.probeMessage"
          "Signature.$"    = "$.probeSignature"
          MessageType      = "RAW"
          SigningAlgorithm = "RSASSA_PSS_SHA_256"
        }
        ResultPath = "$.probeVerification"
        Next       = "DecodeAuthorization"
      }
      DecodeAuthorization = {
        Type = "Pass"
        Parameters = {
          "authorization.$" = "States.StringToJson(States.Base64Decode($.probeMessage))"
        }
        ResultPath = "$.signed"
        Next       = "ProbeVerified"
      }
      ProbeVerified = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.probeVerification.SignatureValid", BooleanEquals = true },
            { Variable = "$.signed.authorization.phase", StringEquals = "continue" },
            { Variable = "$.signed.authorization.runId", StringEqualsPath = "$.runId" },
            { Variable = "$.signed.authorization.epochSha256", StringEqualsPath = "$.epochSha256" },
            { Variable = "$.signed.authorization.continuationManifestSha256", StringEqualsPath = "$.manifestSha256" },
          ]
          Next = "RunTasks"
        }]
        Default = "InvalidPhase"
      }
      RunTasks = {
        Type               = "Map"
        MaxConcurrencyPath = "$.requestedConcurrency"
        ItemReader = {
          Resource     = "arn:aws:states:::s3:getObject"
          ReaderConfig = { InputType = "JSON" }
          Parameters = {
            "Bucket.$" = "$.manifest.bucket"
            "Key.$"    = "$.manifest.key"
          }
        }
        ItemProcessor = {
          ProcessorConfig = { Mode = "DISTRIBUTED", ExecutionType = "STANDARD" }
          StartAt         = "RunPrepare"
          States = {
            RunPrepare = {
              Type     = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              Parameters = {
                LaunchType         = "FARGATE"
                Cluster            = aws_ecs_cluster.eval.arn
                "TaskDefinition.$" = "$.prepareTaskDefinitionArn"
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets        = local.subnet_ids
                    SecurityGroups = [aws_security_group.task.id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = { ContainerOverrides = [{ Name = "prepare", "Command.$" = "$.prepareCommand" }] }
              }
              ResultPath = "$.prepareEcs"
              Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.prepareFailure", Next = "PrepareFailed" }]
              Next       = "RunInference"
            }
            PrepareFailed = { Type = "Pass", End = true }
            RunInference = {
              Type     = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              Parameters = {
                LaunchType         = "FARGATE"
                Cluster            = aws_ecs_cluster.eval.arn
                "TaskDefinition.$" = "$.inferenceTaskDefinitionArn"
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets        = local.subnet_ids
                    SecurityGroups = [aws_security_group.task.id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = {
                  "TaskRoleArn.$"    = "$.inferenceTaskRoleArn"
                  ContainerOverrides = [{ Name = "inference", "Command.$" = "$.inferenceCommand" }]
                }
              }
              ResultPath = "$.inferenceEcs"
              Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.inferenceFailure", Next = "InferenceFailed" }]
              Next       = "RunGrader"
            }
            InferenceFailed = { Type = "Pass", End = true }
            RunGrader = {
              Type     = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              Parameters = {
                LaunchType         = "FARGATE"
                Cluster            = aws_ecs_cluster.eval.arn
                "TaskDefinition.$" = "$.graderTaskDefinitionArn"
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets        = local.subnet_ids
                    SecurityGroups = [aws_security_group.task.id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = { ContainerOverrides = [{ Name = "grader", "Command.$" = "$.graderCommand" }] }
              }
              Retry = [{ ErrorEquals = ["AmazonECS.Unknown", "ECS.AmazonECSException", "ECS.ThrottlingException"], IntervalSeconds = 5, BackoffRate = 2, MaxAttempts = 2 }]
              Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.graderFailure", Next = "GraderFailed" }]
              End   = true
            }
            GraderFailed = { Type = "Pass", End = true }
          }
        }
        ToleratedFailurePercentage = 100
        ResultWriter = {
          Resource = "arn:aws:states:::s3:putObject"
          Parameters = {
            Bucket     = var.artifact_bucket
            "Prefix.$" = "$.resultPrefix"
          }
        }
        End = true
      }
    }
  })
}
