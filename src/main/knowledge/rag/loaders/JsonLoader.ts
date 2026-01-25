import md5 from 'md5'

import type { Chunk } from '../types'
import { cleanString, truncateCenterString } from '../utils/string'
import BaseLoader from './BaseLoader'

export class JsonLoader extends BaseLoader<{ object: string }> {
  private readonly object: unknown
  private readonly pickKeysForEmbedding?: string[]

  constructor({ object, pickKeysForEmbedding }: { object: unknown; pickKeysForEmbedding?: string[] }) {
    super(`JsonLoader_${md5(cleanString(JSON.stringify(object)))}`, { object: truncateCenterString(JSON.stringify(object), 50) })
    this.object = object
    this.pickKeysForEmbedding = pickKeysForEmbedding
  }

  protected override async *getUnfilteredChunks(): AsyncGenerator<Chunk> {
    const source = truncateCenterString(JSON.stringify(this.object), 50)
    const entries = Array.isArray(this.object) ? this.object : [this.object]

    for (const entry of entries) {
      if (entry && typeof entry === 'object' && this.pickKeysForEmbedding && !Array.isArray(entry)) {
        const subset = Object.fromEntries(
          this.pickKeysForEmbedding.filter((key) => key in (entry as any)).map((key) => [key, (entry as any)[key]])
        )
        yield {
          pageContent: cleanString(JSON.stringify(subset)),
          metadata: {
            type: 'JsonLoader',
            source
          }
        }
        continue
      }

      yield {
        pageContent: cleanString(JSON.stringify(entry)),
        metadata: {
          type: 'JsonLoader',
          source
        }
      }
    }
  }
}

