import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { readTextFileWithAutoEncoding } from '@main/utils/file'
import { IpcChannel } from '@shared/IpcChannel'
import type { ReaderChapter } from '@shared/types'
import chardet from 'chardet'
import { BrowserWindow } from 'electron'
import iconv from 'iconv-lite'

type CacheChapter = ReaderChapter & {
  cachePath: string
  charLength: number
  order: number
}

type CacheIndexFile = {
  version: 1
  contentPath: string
  size: number
  mtimeMs: number
  encoding: string
  chapters: Array<{
    id: string
    title: string
    startIndex: number
    endIndex: number
    level: number
    cacheFile: string
    charLength: number
    order: number
  }>
}

const logger = loggerService.withContext('TextReaderCacheService')

const CACHE_VERSION = 1
const DEFAULT_PREVIEW_BYTES = 64 * 1024
const DEFAULT_PREVIEW_CHARS = 50_000
function getCachePaths(contentPath: string) {
  const bookDir = path.dirname(contentPath)
  const cacheDir = path.join(bookDir, 'reader_cache')
  const chaptersDir = path.join(cacheDir, 'chapters')
  const indexPath = path.join(cacheDir, 'chapters.json')
  return { bookDir, cacheDir, chaptersDir, indexPath }
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n/g, '\n')
}

function parseChaptersFromContent(content: string): ReaderChapter[] {
  const patterns: RegExp[] = [/^\s*(第[0-9一二三四五六七八九十百千万零〇]+[章节回卷部篇].*)$/gm, /^\s*(Chapter\s+\d+.*)$/gim]

  const matches: { index: number; title: string }[] = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
     
    while ((m = pattern.exec(content))) {
      if (m.index !== undefined) {
        matches.push({ index: m.index, title: m[1].trim() })
      }
    }
    if (matches.length > 0) break
  }

  const sorted = matches
    .sort((a, b) => a.index - b.index)
    .filter((m, i, arr) => (i === 0 ? true : m.index !== arr[i - 1].index))

  if (sorted.length === 0) {
    return [
      {
        id: 'full',
        title: '正文',
        startIndex: 0,
        endIndex: content.length,
        level: 1
      }
    ]
  }

  return sorted.map((m, idx) => {
    const nextStart = sorted[idx + 1]?.index ?? content.length
    return {
      id: `c${idx + 1}`,
      title: m.title,
      startIndex: m.index,
      endIndex: nextStart,
      level: 1
    }
  })
}
function broadcastCacheUpdated(contentPath: string, payload: { chapters: CacheChapter[]; encoding: string }) {
  const windows = BrowserWindow.getAllWindows()
  for (const w of windows) {
    if (!w.isDestroyed() && w.webContents) {
      w.webContents.send(IpcChannel.TextReader_CacheUpdated, { contentPath, ...payload })
    }
  }
}

async function readPreviewText(contentPath: string, maxBytes = DEFAULT_PREVIEW_BYTES) {
  const stat = await fsPromises.stat(contentPath)
  const size = stat.size
  const toRead = Math.max(0, Math.min(size, maxBytes))

  if (toRead === 0) {
    return { preview: '', encoding: 'utf-8' }
  }

  const handle = await fsPromises.open(contentPath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(toRead)
    await handle.read(buffer, 0, toRead, 0)

    const detected = chardet.detect(buffer)
    let encoding = typeof detected === 'string' ? detected.toLowerCase() : 'utf-8'

    let preview = ''
    try {
      if (encoding.startsWith('gb') || encoding === 'windows-1252') {
        preview = iconv.decode(buffer, 'gbk')
        encoding = 'gbk'
      } else {
        preview = buffer.toString(encoding as BufferEncoding)
      }
    } catch {
      preview = buffer.toString('utf-8')
      encoding = 'utf-8'
    }

    preview = normalizeNewlines(preview)
    if (preview.length > DEFAULT_PREVIEW_CHARS) preview = preview.slice(0, DEFAULT_PREVIEW_CHARS)

    return { preview, encoding }
  } finally {
    await handle.close()
  }
}

export default class TextReaderCacheService {
  private building = new Set<string>()

  public async getCacheIndex(contentPath: string): Promise<{ chapters: CacheChapter[]; encoding: string } | null> {
    const { indexPath, chaptersDir } = getCachePaths(contentPath)
    if (!fs.existsSync(indexPath)) return null

    try {
      const raw = await fsPromises.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw) as CacheIndexFile
      if (parsed.version !== CACHE_VERSION) return null
      if (parsed.contentPath !== contentPath) return null

      const stat = await fsPromises.stat(contentPath)
      if (parsed.mtimeMs !== stat.mtimeMs || parsed.size !== stat.size) {
        return null
      }

      const chapters: CacheChapter[] = parsed.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        startIndex: c.startIndex,
        endIndex: c.endIndex,
        level: c.level,
        cachePath: path.join(chaptersDir, c.cacheFile),
        charLength: c.charLength,
        order: c.order
      }))

      return { chapters, encoding: parsed.encoding }
    } catch (e) {
      logger.warn('Failed to read cache index', e as Error)
      return null
    }
  }

  public async openBook(contentPath: string): Promise<{
    preview: string
    encoding: string
    cache: { chapters: CacheChapter[]; encoding: string } | null
    isBuilding: boolean
  }> {
    const cache = await this.getCacheIndex(contentPath)
    const { preview, encoding } = await readPreviewText(contentPath)

    if (!cache) {
      void this.ensureCache(contentPath)
    }

    return {
      preview,
      encoding,
      cache,
      isBuilding: this.building.has(contentPath)
    }
  }

  public async readChapter(cachePath: string): Promise<string> {
    // chapter cache 始终是 utf-8 写入
    return normalizeNewlines(await fsPromises.readFile(cachePath, 'utf-8'))
  }

  public async rebuildCache(contentPath: string): Promise<void> {
    await this.deleteCache(contentPath)
    await this.ensureCache(contentPath)
  }

  public async ensureCache(contentPath: string): Promise<void> {
    if (this.building.has(contentPath)) return

    this.building.add(contentPath)
    try {
      await this.buildCache(contentPath)
    } finally {
      this.building.delete(contentPath)
    }
  }

  private async deleteCache(contentPath: string) {
    const { cacheDir } = getCachePaths(contentPath)
    try {
      await fsPromises.rm(cacheDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  private async buildCache(contentPath: string) {
    const { cacheDir, chaptersDir, indexPath } = getCachePaths(contentPath)

    await fsPromises.mkdir(chaptersDir, { recursive: true })

    const stat = await fsPromises.stat(contentPath)

    const { content, encoding } = await readTextFileWithAutoEncoding(contentPath)
    const normalized = normalizeNewlines(content)

    const chapters = parseChaptersFromContent(normalized)

    const chapterEntries: CacheIndexFile['chapters'] = []

    // 顺序写入，避免对磁盘造成过大并发压力
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]
      const start = Math.max(0, Math.min(normalized.length, c.startIndex))
      const end = Math.max(start, Math.min(normalized.length, c.endIndex))
      const text = normalized.slice(start, end)

      const cacheFile = `c${String(i + 1).padStart(4, '0')}.txt`
      await fsPromises.writeFile(path.join(chaptersDir, cacheFile), text, 'utf-8')

      chapterEntries.push({
        id: c.id,
        title: c.title,
        startIndex: c.startIndex,
        endIndex: c.endIndex,
        level: c.level,
        cacheFile,
        charLength: text.length,
        order: i
      })
    }

    const index: CacheIndexFile = {
      version: CACHE_VERSION,
      contentPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      encoding,
      chapters: chapterEntries
    }

    await fsPromises.mkdir(cacheDir, { recursive: true })
    await fsPromises.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8')

    const payload = await this.getCacheIndex(contentPath)
    if (payload) {
      broadcastCacheUpdated(contentPath, payload)
    }
  }
}
