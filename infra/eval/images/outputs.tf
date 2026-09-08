output "project_name" { value = aws_codebuild_project.images.name }
output "inference_repository_url" { value = aws_ecr_repository.inference.repository_url }
output "grader_repository_url" { value = aws_ecr_repository.grader.repository_url }
