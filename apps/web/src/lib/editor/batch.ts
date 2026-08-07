import type { Recipe } from '@/lib/recipe/schema'

// Same base-URL contract as orchestratorExportUrl() (export.ts) -- Next.js
// only loads env files from this app's own directory, see .env.example.
const DEFAULT_ORCHESTRATOR_URL = 'http://localhost:3000'

function orchestratorBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? DEFAULT_ORCHESTRATOR_URL
  return base.replace(/\/$/, '')
}

export function orchestratorUrl(path: string): string {
  return `${orchestratorBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

interface PresignUploadResult {
  objectKey: string
  uploadUrl: string
}

// Mirrors apps/orchestrator/src/upload/upload.service.ts's PresignUploadResult
// -- the orchestrator never proxies file bytes (spec P0), so this only asks
// for a presigned MinIO URL; uploadFile below PUTs directly against it.
async function presignUpload(
  file: File,
  fetchImpl: typeof fetch,
): Promise<PresignUploadResult> {
  const res = await fetchImpl(orchestratorUrl('/uploads/presign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`presign upload failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

// Uploads one file end-to-end: presign, then PUT the bytes straight to
// MinIO, and returns the resulting object-storage key -- the same opaque
// string CreateJobDto/CreateBatchJobDto's inputRef(s) expect.
export async function uploadFile(file: File, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { objectKey, uploadUrl } = await presignUpload(file, fetchImpl)
  const putRes = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  if (!putRes.ok) {
    throw new Error(`upload of "${file.name}" failed (${putRes.status}): ${putRes.statusText}`)
  }
  return objectKey
}

interface PipelineResponse {
  id: string
  name: string
}

// Posts recipe.steps to POST /pipelines *unmodified* -- the concrete proof
// of "no convert-my-edit-into-a-pipeline translation step" (CLAUDE.md,
// "Things that must not break"). After TASK-recipe-packages-extraction.md,
// Recipe['steps'] and CreatePipelineDto's StepDto are the same shape.
export async function createPipelineFromRecipe(
  recipe: Recipe,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PipelineResponse> {
  const res = await fetchImpl(orchestratorUrl('/pipelines'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, steps: recipe.steps }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`create pipeline failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

interface JobResponse {
  id: string
}

// Calls POST /jobs (singular) -- creates and dispatches one job for one
// pipeline against one already-uploaded inputRef. Mirrors createBatchJobs's
// shape/error handling; used by the quick-actions screen
// (docs/tasks/TASK-quick-actions-screen.md), which processes a single
// video/audio file per run rather than a batch of many.
export async function createJob(
  pipelineId: string,
  inputRef: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobResponse> {
  const res = await fetchImpl(orchestratorUrl('/jobs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId, inputRef }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`create job failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

interface BatchJobResponse {
  id: string
}

// Calls POST /jobs/batch with the pipeline id and every uploaded key --
// one server call creates all N job rows rather than N client-side
// POST /jobs loops, see docs/tasks/TASK-apply-to-batch.md "Porquê".
export async function createBatchJobs(
  pipelineId: string,
  inputRefs: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<BatchJobResponse[]> {
  const res = await fetchImpl(orchestratorUrl('/jobs/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId, inputRefs }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`create batch jobs failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

export interface ApplyToBatchResult {
  pipelineId: string
  jobIds: string[]
}

// The editor's whole Apply-to-Batch entry point: upload every file, create
// one pipeline from the current recipe, then create one job per uploaded
// file against it. Files upload sequentially -- simple and predictable
// over a small batch; parallelizing is a later optimization, not a
// correctness requirement here.
export async function applyToBatch(
  files: File[],
  recipe: Recipe,
  pipelineName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApplyToBatchResult> {
  const inputRefs: string[] = []
  for (const file of files) {
    inputRefs.push(await uploadFile(file, fetchImpl))
  }

  const pipeline = await createPipelineFromRecipe(recipe, pipelineName, fetchImpl)
  const jobs = await createBatchJobs(pipeline.id, inputRefs, fetchImpl)

  return { pipelineId: pipeline.id, jobIds: jobs.map((job) => job.id) }
}
