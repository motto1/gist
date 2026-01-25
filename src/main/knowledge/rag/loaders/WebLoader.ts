import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { convert } from 'html-to-text'
import md5 from 'md5'

import type { Chunk } from '../types'
import { cleanString, isHttpUrl } from '../utils/string'
import BaseLoader from './BaseLoader'

export class WebLoader extends BaseLoader<{ urlOrContent: string }> {
  private readonly urlOrContent: string

  constructor({
    urlOrContent,
    chunkSize,
    chunkOverlap
  }: {
    urlOrContent: string
    chunkSize?: number
    chunkOverlap?: number
  }) {
    super(`WebLoader_${md5(urlOrContent)}`, { urlOrContent }, chunkSize ?? 1000, chunkOverlap ?? 0)
    this.urlOrContent = urlOrContent
  }

  private async getHtml(): Promise<{ html: string; source: string }> {
    if (isHttpUrl(this.urlOrContent)) {
      const res = await fetch(this.urlOrContent)
      if (!res.ok) {
        throw new Error(`Failed to fetch url: ${this.urlOrContent} (${res.status})`)
      }
      return { html: await res.text(), source: this.urlOrContent }
    }
    return { html: this.urlOrContent, source: 'html' }
  }

  protected override async *getUnfilteredChunks(): AsyncGenerator<Chunk> {
    const { html, source } = await this.getHtml()
    const text = convert(html, {
      wordwrap: false,
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' }
      ]
    })

    const chunker = new RecursiveCharacterTextSplitter({
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap
    })
    const chunks = await chunker.splitText(cleanString(text))
    for (const chunk of chunks) {
      yield {
        pageContent: chunk,
        metadata: {
          type: 'WebLoader',
          source
        }
      }
    }
  }
}

