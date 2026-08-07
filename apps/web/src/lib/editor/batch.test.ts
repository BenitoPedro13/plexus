import { describe, expect, it, vi } from 'vitest'
import type { Recipe } from '@/lib/recipe/schema'
import { applyToBatch, createBatchJobs, createPipelineFromRecipe, orchestratorUrl, uploadFile } from './batch'

const recipe: Recipe = {
  steps: [{ id: 'resize', processor: 'image.resize', params: { width: 400, height: 400, fit: 'inside' } }],
}

describe('orchestratorUrl', () => {
  it('joins the base URL and path, tolerating either leading slash form', () => {
    expect(orchestratorUrl('/uploads/presign')).toBe('http://localhost:3000/uploads/presign')
    expect(orchestratorUrl('jobs/batch')).toBe('http://localhost:3000/jobs/batch')
  })
})

describe('uploadFile', () => {
  it('presigns then PUTs the file bytes directly to the returned uploadUrl', async () => {
    const file = new File(['bytes'], 'a.jpg', { type: 'image/jpeg' })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ objectKey: 'uploads/a.jpg', uploadUrl: 'https://minio.local/put-me' }),
      })
      .mockResolvedValueOnce({ ok: true })

    const objectKey = await uploadFile(file, fetchImpl as unknown as typeof fetch)

    expect(objectKey).toBe('uploads/a.jpg')
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3000/uploads/presign',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ filename: 'a.jpg', contentType: 'image/jpeg' }),
      }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://minio.local/put-me',
      expect.objectContaining({ method: 'PUT', body: file }),
    )
  })

  it('throws with the server error text when presigning fails', async () => {
    const file = new File(['bytes'], 'a.jpg', { type: 'image/jpeg' })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve('filename must not be empty'),
    })

    await expect(uploadFile(file, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /400.*filename must not be empty/,
    )
  })

  it('throws when the direct PUT to object storage fails', async () => {
    const file = new File(['bytes'], 'a.jpg', { type: 'image/jpeg' })
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ objectKey: 'uploads/a.jpg', uploadUrl: 'https://minio.local/put-me' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' })

    await expect(uploadFile(file, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/403/)
  })
})

describe('createPipelineFromRecipe', () => {
  it('posts recipe.steps unmodified as the pipeline definition', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pipeline-1', name: 'batch' }),
    })

    const pipeline = await createPipelineFromRecipe(recipe, 'batch', fetchImpl as unknown as typeof fetch)

    expect(pipeline).toEqual({ id: 'pipeline-1', name: 'batch' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/pipelines',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'batch', steps: recipe.steps }),
      }),
    )
  })
})

describe('createBatchJobs', () => {
  it('posts pipelineId and every inputRef to POST /jobs/batch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 'job-1' }, { id: 'job-2' }]),
    })

    const jobs = await createBatchJobs(
      'pipeline-1',
      ['uploads/a.jpg', 'uploads/b.jpg'],
      fetchImpl as unknown as typeof fetch,
    )

    expect(jobs).toEqual([{ id: 'job-1' }, { id: 'job-2' }])
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/jobs/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ pipelineId: 'pipeline-1', inputRefs: ['uploads/a.jpg', 'uploads/b.jpg'] }),
      }),
    )
  })
})

describe('applyToBatch', () => {
  it('uploads every file, creates one pipeline, then one batch job call', async () => {
    const files = [
      new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
    ]

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/uploads/presign')) {
        const filename = JSON.parse(init?.body as string).filename
        return { ok: true, json: () => Promise.resolve({ objectKey: `uploads/${filename}`, uploadUrl: `https://minio.local/${filename}` }) }
      }
      if (url.startsWith('https://minio.local/')) {
        return { ok: true }
      }
      if (url.endsWith('/pipelines')) {
        return { ok: true, json: () => Promise.resolve({ id: 'pipeline-1', name: 'batch' }) }
      }
      if (url.endsWith('/jobs/batch')) {
        return { ok: true, json: () => Promise.resolve([{ id: 'job-1' }, { id: 'job-2' }]) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const result = await applyToBatch(files, recipe, 'batch', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ pipelineId: 'pipeline-1', jobIds: ['job-1', 'job-2'] })
    // 2 presign + 2 PUT + 1 pipeline + 1 batch-jobs
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })
})
