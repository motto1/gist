import { EventEmitter } from 'node:events'

import md5 from 'md5'

import type { Chunk, ChunkWithHash } from '../types'
import { cleanString } from '../utils/string'

export default abstract class BaseLoader<TLoaderMetadata extends Record<string, any> = Record<string, any>> extends EventEmitter {
  protected readonly uniqueId: string
  protected readonly chunkSize: number
  protected readonly chunkOverlap: number
  protected readonly loaderMetadata: TLoaderMetadata

  constructor(uniqueId: string, loaderMetadata: TLoaderMetadata, chunkSize = 1000, chunkOverlap = 0) {
    super()
    this.uniqueId = uniqueId
    this.chunkSize = chunkSize
    this.chunkOverlap = chunkOverlap
    this.loaderMetadata = loaderMetadata
  }

  public getUniqueId(): string {
    return this.uniqueId
  }

  public async init(): Promise<void> {}

  public injectModel(_model: unknown): void {}

  protected abstract getUnfilteredChunks(): AsyncGenerator<Chunk>

  public async *getChunks(): AsyncGenerator<ChunkWithHash> {
    for await (const chunk of this.getUnfilteredChunks()) {
      const pageContent = cleanString(chunk.pageContent)
      if (!pageContent) continue
      yield {
        ...chunk,
        pageContent,
        contentHash: md5(pageContent)
      }
    }
  }
}

