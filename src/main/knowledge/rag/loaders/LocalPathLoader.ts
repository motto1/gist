import fs from 'node:fs'
import path from 'node:path'

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import md5 from 'md5'
import { parseOfficeAsync } from 'officeparser'

// 延迟加载 pdf-parse 以避免模块加载时读取测试文件
let pdfParseModule: typeof import('pdf-parse') | null = null
const getPdfParse = async () => {
  if (!pdfParseModule) {
    pdfParseModule = await import('pdf-parse')
  }
  return pdfParseModule.default
}

import type { Chunk } from '../types'
import { cleanString } from '../utils/string'
import BaseLoader from './BaseLoader'

const splitText = async (text: string, chunkSize: number, chunkOverlap: number): Promise<string[]> => {
  const chunker = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap })
  return chunker.splitText(cleanString(text))
}

export class LocalPathLoader extends BaseLoader<{ path: string }> {
  private readonly targetPath: string

  constructor({ path: targetPath, chunkSize, chunkOverlap }: { path: string; chunkSize?: number; chunkOverlap?: number }) {
    super(`LocalPathLoader_${md5(targetPath)}`, { path: targetPath }, chunkSize ?? 1000, chunkOverlap ?? 0)
    this.targetPath = targetPath
  }

  protected override async *getUnfilteredChunks(): AsyncGenerator<Chunk> {
    for await (const result of this.recursivelyAddPath(this.targetPath)) {
      yield {
        ...result,
        metadata: {
          ...result.metadata,
          type: 'LocalPathLoader',
          originalPath: this.targetPath
        }
      }
    }
  }

  private async *recursivelyAddPath(currentPath: string): AsyncGenerator<Chunk> {
    const stat = fs.lstatSync(currentPath)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(currentPath)
      for (const entry of entries) {
        yield* this.recursivelyAddPath(path.resolve(currentPath, entry))
      }
      return
    }

    const ext = path.extname(currentPath).toLowerCase()
    let extractedText = ''
    try {
      if (ext === '.pdf') {
        const pdfParse = await getPdfParse()
        const parsed = await pdfParse(fs.readFileSync(currentPath))
        extractedText = parsed.text
      } else if (['.doc', '.docx', '.pptx', '.xlsx', '.ppt', '.xls'].includes(ext)) {
        extractedText = await parseOfficeAsync(currentPath)
      } else {
        extractedText = fs.readFileSync(currentPath, 'utf-8')
      }
    } catch {
      return
    }

    const chunks = await splitText(extractedText, this.chunkSize, this.chunkOverlap)
    for (const chunk of chunks) {
      yield {
        pageContent: chunk,
        metadata: {
          source: currentPath
        }
      }
    }
  }
}

