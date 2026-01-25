import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import md5 from 'md5'

import type { Chunk } from '../types'
import { cleanString, truncateCenterString } from '../utils/string'
import BaseLoader from './BaseLoader'

export class TextLoader extends BaseLoader<{ text: string }> {
  private readonly text: string

  constructor({ text, chunkSize, chunkOverlap }: { text: string; chunkSize?: number; chunkOverlap?: number }) {
    super(`TextLoader_${md5(text)}`, { text: truncateCenterString(text, 50) }, chunkSize ?? 300, chunkOverlap ?? 0)
    this.text = text
  }

  protected override async *getUnfilteredChunks(): AsyncGenerator<Chunk> {
    const source = truncateCenterString(this.text, 50)
    const chunker = new RecursiveCharacterTextSplitter({
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap
    })
    const chunks = await chunker.splitText(cleanString(this.text))
    for (const chunk of chunks) {
      yield {
        pageContent: chunk,
        metadata: {
          type: 'TextLoader',
          source,
          textId: this.uniqueId
        }
      }
    }
  }
}

