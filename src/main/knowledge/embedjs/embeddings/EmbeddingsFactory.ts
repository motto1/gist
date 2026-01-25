import { BaseEmbeddings } from '@main/knowledge/rag'
import type { ApiClient } from '@types'

import { VoyageEmbeddings } from './VoyageEmbeddings'

const ensureTrailingSlash = (value: string): string => (value.endsWith('/') ? value : `${value}/`)

const readErrorBody = async (res: Response): Promise<string> => {
  try {
    const text = await res.text()
    return text ? text.slice(0, 2000) : ''
  } catch {
    return ''
  }
}

class OpenAIEmbeddings extends BaseEmbeddings {
  private resolvedDimensions?: number

  constructor(
    private readonly config: {
      model: string
      apiKey: string
      baseURL: string
      dimensions?: number
      batchSize?: number
    }
  ) {
    super()
    this.resolvedDimensions = config.dimensions
  }

  private async requestEmbeddings(input: string | string[]): Promise<number[][]> {
    const url = new URL('embeddings', ensureTrailingSlash(this.config.baseURL)).toString()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input
      })
    })
    if (!res.ok) {
      throw new Error(`OpenAI embeddings request failed (${res.status}): ${await readErrorBody(res)}`)
    }
    const json = (await res.json()) as any
    return (json?.data ?? []).map((item: any) => item.embedding as number[])
  }

  public override async getDimensions(): Promise<number> {
    if (this.resolvedDimensions) return this.resolvedDimensions
    const vec = await this.embedQuery('test')
    this.resolvedDimensions = vec.length
    return this.resolvedDimensions
  }

  public override async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.requestEmbeddings(texts)
  }

  public override async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.requestEmbeddings(text)
    return vec
  }
}

class AzureOpenAIEmbeddings extends BaseEmbeddings {
  private resolvedDimensions?: number

  constructor(
    private readonly config: {
      deployment: string
      apiKey: string
      apiVersion: string
      endpoint: string
      dimensions?: number
    }
  ) {
    super()
    this.resolvedDimensions = config.dimensions
  }

  private async requestEmbeddings(input: string | string[]): Promise<number[][]> {
    const base = ensureTrailingSlash(this.config.endpoint)
    const url = new URL(`openai/deployments/${encodeURIComponent(this.config.deployment)}/embeddings`, base)
    url.searchParams.set('api-version', this.config.apiVersion)

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.config.apiKey
      },
      body: JSON.stringify({
        input
      })
    })
    if (!res.ok) {
      throw new Error(`Azure OpenAI embeddings request failed (${res.status}): ${await readErrorBody(res)}`)
    }
    const json = (await res.json()) as any
    return (json?.data ?? []).map((item: any) => item.embedding as number[])
  }

  public override async getDimensions(): Promise<number> {
    if (this.resolvedDimensions) return this.resolvedDimensions
    const vec = await this.embedQuery('test')
    this.resolvedDimensions = vec.length
    return this.resolvedDimensions
  }

  public override async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.requestEmbeddings(texts)
  }

  public override async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.requestEmbeddings(text)
    return vec
  }
}

class OllamaEmbeddings extends BaseEmbeddings {
  private resolvedDimensions?: number

  constructor(
    private readonly config: {
      model: string
      baseURL: string
      dimensions?: number
    }
  ) {
    super()
    this.resolvedDimensions = config.dimensions
  }

  private isOpenAICompatible(): boolean {
    return /\/v1\/?$/.test(this.config.baseURL) || /\/v1\//.test(this.config.baseURL)
  }

  private async requestEmbeddingsOpenAICompatible(input: string | string[]): Promise<number[][]> {
    const url = new URL('embeddings', ensureTrailingSlash(this.config.baseURL)).toString()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, input })
    })
    if (!res.ok) {
      throw new Error(`Ollama OpenAI-compatible embeddings request failed (${res.status}): ${await readErrorBody(res)}`)
    }
    const json = (await res.json()) as any
    return (json?.data ?? []).map((item: any) => item.embedding as number[])
  }

  private async requestEmbeddingsNative(input: string[]): Promise<number[][]> {
    const base = ensureTrailingSlash(this.config.baseURL)
    const embedUrl = new URL('api/embed', base).toString()
    const res = await fetch(embedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, input })
    })

    if (res.ok) {
      const json = (await res.json()) as any
      const embeddings = json?.embeddings
      if (Array.isArray(embeddings)) return embeddings as number[][]
    }

    const fallbackUrl = new URL('api/embeddings', base).toString()
    const vectors: number[][] = []
    for (const text of input) {
      const r = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, prompt: text })
      })
      if (!r.ok) {
        throw new Error(`Ollama embeddings request failed (${r.status}): ${await readErrorBody(r)}`)
      }
      const j = (await r.json()) as any
      vectors.push(j.embedding as number[])
    }
    return vectors
  }

  private async requestEmbeddings(input: string | string[]): Promise<number[][]> {
    if (this.isOpenAICompatible()) {
      return this.requestEmbeddingsOpenAICompatible(input)
    }
    const arr = Array.isArray(input) ? input : [input]
    return this.requestEmbeddingsNative(arr)
  }

  public override async getDimensions(): Promise<number> {
    if (this.resolvedDimensions) return this.resolvedDimensions
    const vec = await this.embedQuery('test')
    this.resolvedDimensions = vec.length
    return this.resolvedDimensions
  }

  public override async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.requestEmbeddings(texts)
  }

  public override async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.requestEmbeddings(text)
    return vec
  }
}

export default class EmbeddingsFactory {
  static create({ embedApiClient, dimensions }: { embedApiClient: ApiClient; dimensions?: number }): BaseEmbeddings {
    const { model, provider, apiKey, apiVersion, baseURL } = embedApiClient
    if (provider === 'voyageai') {
      return new VoyageEmbeddings({
        modelName: model,
        apiKey,
        outputDimension: dimensions,
        batchSize: 8
      })
    }
    if (provider === 'ollama') {
      return new OllamaEmbeddings({ model, baseURL, dimensions })
    }
    if (apiVersion !== undefined) {
      return new AzureOpenAIEmbeddings({
        deployment: model,
        apiKey,
        apiVersion,
        endpoint: baseURL,
        dimensions
      })
    }
    return new OpenAIEmbeddings({ model, apiKey, baseURL, dimensions })
  }
}
