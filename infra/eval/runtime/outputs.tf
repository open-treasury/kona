output "cluster_arn" { value = aws_ecs_cluster.eval.arn }
output "state_machine_arn" { value = aws_sfn_state_machine.eval.arn }
output "subnet_ids" { value = aws_subnet.public[*].id }
output "security_group_id" { value = aws_security_group.task.id }
output "inference_task_definitions" { value = { for key, task in aws_ecs_task_definition.inference : key => task.arn } }
output "prepare_task_definitions" { value = { for key, task in aws_ecs_task_definition.prepare : key => task.arn } }
output "grader_task_definitions" { value = { for key, task in aws_ecs_task_definition.grader : key => task.arn } }
output "inference_repository_url" { value = aws_ecr_repository.inference.repository_url }
output "grader_repository_url" { value = aws_ecr_repository.grader.repository_url }
output "pure_inference_task_role_arn" { value = aws_iam_role.inference_task.arn }
output "kona_inference_task_role_arn" { value = aws_iam_role.kona_inference_task.arn }
output "artifact_bucket" { value = var.artifact_bucket }
output "region" { value = var.aws_region }
output "active_run_id" { value = var.active_run_id }
output "probe_signing_key_arn" { value = aws_kms_key.probe_approval.arn }
output "launcher_policy_arn" { value = aws_iam_policy.launcher.arn }
output "approver_policy_arn" { value = aws_iam_policy.approver.arn }
