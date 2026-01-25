import { readTextFileWithAutoEncoding } from '@main/utils/file'
import { TraceMethod } from '@mcp-trace/trace-core'
import fs from 'fs/promises'
import path from 'path'

export default class FileService {
  @TraceMethod({ spanName: 'readFile', tag: 'FileService' })
  public static async readFile(_: Electron.IpcMainInvokeEvent, pathOrUrl: string, encoding?: BufferEncoding) {
    const target = pathOrUrl.startsWith('file://') ? new URL(pathOrUrl) : pathOrUrl
    if (encoding) return fs.readFile(target, { encoding })
    return fs.readFile(target)
  }

  /**
   * 自动识别编码，读取文本文件
   * @param _ event
   * @param pathOrUrl
   */
  @TraceMethod({ spanName: 'readTextFileWithAutoEncoding', tag: 'FileService' })
  public static async readTextFileWithAutoEncoding(_: Electron.IpcMainInvokeEvent, path: string): Promise<string> {
    try {
      return (await readTextFileWithAutoEncoding(path)).content
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  @TraceMethod({ spanName: 'readdir', tag: 'FileService' })
  public static async readdir(_: Electron.IpcMainInvokeEvent, dirPath: string): Promise<
    Array<{
      name: string
      path: string
      isDirectory: boolean
      isFile: boolean
      mtimeMs: number
      size: number
    }>
  > {
    let entries: Array<import('fs').Dirent>
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return []
      }
      throw error
    }

    const enriched = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name)
        const stat = await fs.stat(fullPath)
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          mtimeMs: stat.mtimeMs,
          size: stat.size
        }
      })
    )

    return enriched
  }
}
