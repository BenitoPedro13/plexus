import { describe, expect, it, vi } from 'vitest'
import type { Recipe } from '@/lib/recipe/schema'
import { buildExportFormData, exportRecipe, orchestratorExportUrl, triggerDownload } from './export'

const recipe: Recipe = {
  steps: [{ id: 'crop', processor: 'image.crop', params: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
}

// Assigning `undefined` to a process.env property stringifies it to
// "undefined" instead of deleting the key -- restoring via plain
// assignment would leak a bogus value into later tests, so this always
// deletes when there was nothing to restore.
function restoreOrchestratorUrlEnv(original: string | undefined) {
  if (original === undefined) {
    delete process.env.NEXT_PUBLIC_ORCHESTRATOR_URL
  } else {
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL = original
  }
}

describe('orchestratorExportUrl', () => {
  it('defaults to localhost:3000 when NEXT_PUBLIC_ORCHESTRATOR_URL is unset', () => {
    const original = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL
    delete process.env.NEXT_PUBLIC_ORCHESTRATOR_URL

    expect(orchestratorExportUrl()).toBe('http://localhost:3000/export')

    restoreOrchestratorUrlEnv(original)
  })

  it('respects a configured base URL and strips a trailing slash', () => {
    const original = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL = 'https://api.example.com/'

    expect(orchestratorExportUrl()).toBe('https://api.example.com/export')

    restoreOrchestratorUrlEnv(original)
  })
})

describe('buildExportFormData', () => {
  it('includes the original file byte-for-byte and just the recipe steps', async () => {
    const file = new File(['source-bytes'], 'photo.jpg', { type: 'image/jpeg' })

    const form = buildExportFormData(file, recipe)

    const filePart = form.get('file') as File
    expect(filePart.name).toBe('photo.jpg')
    expect(await filePart.text()).toBe('source-bytes')

    const recipePart = form.get('recipe') as string
    expect(JSON.parse(recipePart)).toEqual(recipe.steps)
  })
})

describe('exportRecipe', () => {
  it('resolves with the rendered blob on a 2xx response', async () => {
    const file = new File(['source-bytes'], 'photo.jpg', { type: 'image/jpeg' })
    const rendered = new Blob(['rendered-bytes'], { type: 'image/jpeg' })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(rendered),
    })

    const result = await exportRecipe(file, recipe, fetchImpl as unknown as typeof fetch)

    expect(result).toBe(rendered)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/export',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws with the server error text on a non-2xx response', async () => {
    const file = new File(['source-bytes'], 'photo.jpg', { type: 'image/jpeg' })
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: () => Promise.resolve('step 0: unknown processor "bogus"'),
    })

    await expect(exportRecipe(file, recipe, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /422.*unknown processor/,
    )
  })
})

describe('triggerDownload', () => {
  it('creates and clicks a temporary anchor, then revokes the object URL', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') el.click = clickSpy
      return el
    })

    triggerDownload(new Blob(['bytes'], { type: 'image/png' }), 'my-photo')

    expect(createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url')

    createElementSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('picks the download filename extension from the blob content type', () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:fake-url'), revokeObjectURL: vi.fn() })
    let downloadName = ''
    const originalCreateElement = document.createElement.bind(document)
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === 'a') {
        el.click = vi.fn()
        Object.defineProperty(el, 'download', {
          set: (value: string) => {
            downloadName = value
          },
          get: () => downloadName,
        })
      }
      return el
    })

    triggerDownload(new Blob(['bytes'], { type: 'image/png' }), 'my-photo')

    expect(downloadName).toBe('my-photo.png')

    createElementSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})
