import { sha256, type ArmRequest, type FastManifest } from "./contracts.ts";

export type DatasetRow = Record<string, unknown> & {
  instance_id: string;
  image_name: string;
};

export type InfrastructureOutputs = {
  artifactBucket: string;
  stateMachineArn: string;
  inferenceTaskDefinitions: Record<string, string>;
  prepareTaskDefinitions: Record<string, string>;
  graderTaskDefinitions: Record<string, string>;
  pureInferenceTaskRoleArn: string;
  konaInferenceTaskRoleArn: string;
  probeSigningKeyArn: string;
};

export type PreparedTask = {
  taskId: string;
  taskKey: string;
  prepareRequest: Record<string, unknown>;
  inferenceRequest: Record<string, unknown>;
  graderRequest: Record<string, unknown>;
  workflowItem: {
    taskId: string;
    prepareTaskDefinitionArn: string;
    inferenceTaskDefinitionArn: string;
    inferenceTaskRoleArn: string;
    graderTaskDefinitionArn: string;
    inferenceCommand: string[];
    prepareCommand: string[];
    graderCommand: string[];
  };
};

const requiredInferenceFields = [
  "instance_id",
  "problem_statement",
  "image_name",
  "repo_settings",
] as const;
const requiredPreparationFields = [...requiredInferenceFields, "patch", "FAIL_TO_PASS"] as const;
const requiredGraderFields = [
  ...requiredPreparationFields,
  "repo",
  "level",
  "test_patch",
  "PASS_TO_PASS",
] as const;

const select = (row: DatasetRow, fields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(
    fields.map((field) => {
      if (!(field in row)) throw new Error(`dataset row ${row.instance_id} is missing ${field}`);
      return [field, row[field]];
    }),
  );

export const taskKey = (taskId: string): string => {
  const slug = taskId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
  return `${slug}-${sha256(taskId).slice(0, 8)}`;
};

export const prepareTasks = (
  manifest: FastManifest,
  rows: readonly DatasetRow[],
  request: ArmRequest,
  runId: string,
  infrastructure: InfrastructureOutputs,
): PreparedTask[] => {
  const byId = new Map(rows.map((row) => [row.instance_id, row]));
  if (byId.size !== rows.length) throw new Error("dataset rows contain duplicate task ids");
  return manifest.tasks.map((taskId) => {
    const row = byId.get(taskId);
    if (row === undefined) throw new Error(`dataset is missing pinned task ${taskId}`);
    const inferenceTaskDefinitionArn = infrastructure.inferenceTaskDefinitions[row.image_name];
    const prepareTaskDefinitionArn = infrastructure.prepareTaskDefinitions[row.image_name];
    const graderTaskDefinitionArn = infrastructure.graderTaskDefinitions[row.image_name];
    if (!prepareTaskDefinitionArn || !inferenceTaskDefinitionArn || !graderTaskDefinitionArn) {
      throw new Error(`image family ${row.image_name} has no pinned task definitions`);
    }
    const key = taskKey(taskId);
    const prefix = `staging/v1/runs/${runId}/tasks/${key}`;
    const prepareRequestKey = `requests/v1/runs/${runId}/prepare/${key}.json`;
    const inferenceRequestKey = `requests/v1/runs/${runId}/inference/${key}.json`;
    const graderRequestKey = `requests/v1/runs/${runId}/grader/${key}.json`;
    return {
      taskId,
      taskKey: key,
      prepareRequest: {
        schema_version: 1,
        epoch_sha256: request.epochSha256,
        run_id: runId,
        task: select(row, requiredPreparationFields),
        output_prefix: `${prefix}/prepared`,
      },
      inferenceRequest: {
        schema_version: 1,
        epoch_sha256: request.epochSha256,
        run_id: runId,
        arm_type: request.armType,
        task: select(row, requiredInferenceFields),
        model: "azure/gpt-5.6-sol",
        model_reasoning_effort: "xhigh",
        output_prefix: `${prefix}/inference`,
        prepared_claim_key: `${prefix}/claims/workspace-preparation.json`,
        model_claim_key: `${prefix}/claims/model-attempt-1.json`,
        kona: request.kona,
      },
      graderRequest: {
        schema_version: 1,
        epoch_sha256: request.epochSha256,
        run_id: runId,
        task: select(row, requiredGraderFields),
        inference_claim_key: `${prefix}/claims/model-attempt-1.json`,
        output_prefix: `${prefix}/grader`,
      },
      workflowItem: {
        taskId,
        prepareTaskDefinitionArn,
        inferenceTaskDefinitionArn,
        inferenceTaskRoleArn:
          request.armType === "pure-gpt"
            ? infrastructure.pureInferenceTaskRoleArn
            : infrastructure.konaInferenceTaskRoleArn,
        graderTaskDefinitionArn,
        prepareCommand: ["prepare", `s3://${infrastructure.artifactBucket}/${prepareRequestKey}`],
        inferenceCommand: ["infer", `s3://${infrastructure.artifactBucket}/${inferenceRequestKey}`],
        graderCommand: ["grade", `s3://${infrastructure.artifactBucket}/${graderRequestKey}`],
      },
    };
  });
};

export const phaseTasks = (
  tasks: readonly PreparedTask[],
  phase: "probe" | "continue",
): PreparedTask[] => (phase === "probe" ? tasks.slice(0, 3) : tasks.slice(3));
