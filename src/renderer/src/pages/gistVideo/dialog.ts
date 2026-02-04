import type { FileMetadata } from '@types'

const toPaths = (files: FileMetadata[] | null): string[] => {
  if (!files || !Array.isArray(files)) return []
  return files.map((f) => String(f.path || '')).filter((p) => !!p)
}

export async function pickVideos(): Promise<string[]> {
  const files = await window.api.file.select({
    title: '选择视频文件（支持多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Videos',
        extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v']
      }
    ]
  })
  return toPaths(files)
}

export async function pickImages(max: number = 9): Promise<string[]> {
  const files = await window.api.file.select({
    title: '选择图片（支持多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp']
      }
    ]
  })
  return toPaths(files).slice(0, Math.max(1, max))
}

export async function pickOutputMp4(defaultPath: string): Promise<string | null> {
  const p = await window.api.file.selectSavePath({
    title: '选择输出 MP4',
    defaultPath,
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  })
  if (!p) return null
  return p.toLowerCase().endsWith('.mp4') ? p : `${p}.mp4`
}

