import { describe, expect, it } from 'vitest'
import { detectKind, presetsFor } from './presets'

function fileWith(name: string, type: string): File {
  return new File([], name, { type })
}

describe('detectKind', () => {
  it('detects a video file', () => {
    expect(detectKind(fileWith('clip.mp4', 'video/mp4'))).toBe('video')
  })

  it('detects an audio file', () => {
    expect(detectKind(fileWith('song.mp3', 'audio/mpeg'))).toBe('audio')
  })

  it('detects an image file', () => {
    expect(detectKind(fileWith('photo.jpg', 'image/jpeg'))).toBe('image')
  })

  it('returns null for an unrecognized file type', () => {
    expect(detectKind(fileWith('archive.zip', 'application/zip'))).toBeNull()
  })
})

describe('presetsFor(image)', () => {
  it('emits an image.convert step per target format', () => {
    const presets = presetsFor('image', 'photo.heic')
    const jpeg = presets.find((preset) => preset.id === 'convert-jpeg')
    expect(jpeg?.steps).toEqual([{ id: 'convert', processor: 'image.convert', params: { format: 'jpeg', quality: 85 } }])
  })

  it('emits a single image.compress step', () => {
    const presets = presetsFor('image', 'photo.jpg')
    const compress = presets.find((preset) => preset.id === 'compress')
    expect(compress?.steps).toEqual([{ id: 'compress', processor: 'image.compress', params: { quality: 70 } }])
  })
})

describe('presetsFor(video)', () => {
  it('emits a single video.compress step for an already-mp4 input', () => {
    const [shrink] = presetsFor('video', 'clip.mp4')
    expect(shrink.steps).toEqual([{ id: 'compress', processor: 'video.compress', params: { quality: 30 } }])
  })

  it('emits a webm-container input as a single compress step too', () => {
    const [shrink] = presetsFor('video', 'clip.webm')
    expect(shrink.steps).toEqual([{ id: 'compress', processor: 'video.compress', params: { quality: 30 } }])
  })

  it('chains transcode-then-compress for a non-mp4/webm container', () => {
    const [shrink] = presetsFor('video', 'clip.mov')
    expect(shrink.steps).toEqual([
      { id: 'transcode', processor: 'video.transcode', params: { format: 'mp4', quality: 75 } },
      { id: 'compress', processor: 'video.compress', params: { quality: 30 } },
    ])
  })

  it('offers convert-to-mp4/webm and extract-audio presets regardless of container', () => {
    const presets = presetsFor('video', 'clip.mkv')
    expect(presets.map((p) => p.id)).toEqual(['shrink', 'to-mp4', 'to-webm', 'extract-audio'])
  })
})

describe('presetsFor(audio)', () => {
  it('offers mp3/wav/aac conversion presets', () => {
    const presets = presetsFor('audio', 'song.flac')
    expect(presets.map((p) => p.id)).toEqual(['to-mp3', 'to-wav', 'to-aac'])
    expect(presets[0].steps).toEqual([
      { id: 'convert', processor: 'audio.convert', params: { format: 'mp3', bitrate: 128 } },
    ])
  })
})
