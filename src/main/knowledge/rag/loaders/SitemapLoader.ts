import { XMLParser } from 'fast-xml-parser'
import md5 from 'md5'

import type { Chunk } from '../types'
import BaseLoader from './BaseLoader'
import { WebLoader } from './WebLoader'

const extractSitemapUrls = (xml: string): string[] => {
  const parser = new XMLParser({ ignoreAttributes: true })
  const parsed = parser.parse(xml) as any
  const url = parsed?.urlset?.url
  const entries = Array.isArray(url) ? url : url ? [url] : []
  return entries.map((u: any) => u?.loc).filter((loc: any) => typeof loc === 'string' && loc.length > 0)
}

export class SitemapLoader extends BaseLoader<{ url: string }> {
  private readonly url: string

  constructor({ url, chunkSize, chunkOverlap }: { url: string; chunkSize?: number; chunkOverlap?: number }) {
    super(`SitemapLoader_${md5(url)}`, { url }, chunkSize ?? 1000, chunkOverlap ?? 0)
    this.url = url
  }

  protected override async *getUnfilteredChunks(): AsyncGenerator<Chunk> {
    const res = await fetch(this.url)
    if (!res.ok) {
      throw new Error(`Failed to fetch sitemap: ${this.url} (${res.status})`)
    }
    const xml = await res.text()
    const urls = extractSitemapUrls(xml)
    for (const url of urls) {
      const webLoader = new WebLoader({ urlOrContent: url, chunkSize: this.chunkSize, chunkOverlap: this.chunkOverlap })
      for await (const chunk of webLoader.getChunks()) {
        yield {
          pageContent: chunk.pageContent,
          metadata: {
            ...chunk.metadata,
            type: 'SitemapLoader',
            source: url
          }
        }
      }
    }
  }
}

