mock_provider "aws" {}

override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-east-1a", "us-east-1b"] }
}

override_data {
  target = data.aws_iam_policy_document.ecs_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.states_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.inference_execution
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.grader_execution
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.inference_task
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.kona_bundle[0]
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.grader_task
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.prepare_task
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.states
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.launcher
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

override_data {
  target = data.aws_iam_policy_document.approver
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}

variables {
  active_run_id            = "fb11-fast-aaaaaaaaaaaaaaaa--pure-gpt"
  kona_bundle_sha256       = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  artifact_bucket          = "kona-eval-artifacts-123456789012"
  artifact_kms_key_arn     = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000"
  azure_secret_arn         = "arn:aws:secretsmanager:us-east-1:123456789012:secret:kona-azure"
  azure_secret_kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111"
  azure_api_base           = "https://example.openai.azure.com/openai/v1/"
  requested_concurrency    = 50
  image_pairs = {
    astropy      = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    fastapi      = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    hatch        = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    matplotlib   = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    meson        = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    metaflow     = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    mlflow       = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    mypy         = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    packaging    = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    pandas       = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    pydantic     = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    pytest       = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    scikit_learn = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    seaborn      = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    setuptools   = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    sphinx       = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    sympy        = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    xarray       = { inference = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", grader = "123456789012.dkr.ecr.us-east-1.amazonaws.com/kona-eval/grader@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
}

run "fargate_runtime" {
  command = plan

  assert {
    condition     = length(aws_ecs_task_definition.prepare) == 18 && length(aws_ecs_task_definition.inference) == 18 && length(aws_ecs_task_definition.grader) == 18
    error_message = "All 18 image families require isolated prepare, inference, and grader task definitions."
  }

  assert {
    condition     = aws_sfn_state_machine.eval.type == "STANDARD"
    error_message = "Distributed Map orchestration must use a Standard workflow."
  }

}
