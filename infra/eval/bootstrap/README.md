# Evaluation bootstrap

This root creates the durable Terraform-state and DVC/artifact buckets. Initialize it once with the
local backend and apply a reviewed plan. Then copy `backend.s3.tf.example` to the Git-ignored local
file `backend.tf`, write the non-secret `backend_config` output to a local backend configuration
file, and run `terraform init -migrate-state -backend-config=...`. The migrated backend uses S3
native locking. Do not add DynamoDB locking or commit `backend.tf`.

Both buckets and KMS keys use `prevent_destroy`. Runtime teardown is performed only from
`../runtime` and cannot address these resources.
