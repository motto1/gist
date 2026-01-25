import type BaseEmbeddings from '../embeddings/BaseEmbeddings'
import type BaseLoader from '../loaders/BaseLoader'
import type { AddLoaderReturn, SimilaritySearchResult, VectorDbInsertChunk } from '../types'
import RAGApplicationBuilder from './RAGApplicationBuilder'

const DEFAULT_INSERT_BATCH_SIZE = 50

export default class RAGApplication {
  private readonly embeddingModel: BaseEmbeddings
  private readonly vectorDatabase: { init: (p: { dimensions?: number }) => Promise<void>; insertChunks: (c: VectorDbInsertChunk[]) => Promise<number>; similaritySearch: (q: number[], k: number) => Promise<SimilaritySearchResult[]>; deleteKeys: (id: string) => Promise<boolean>; reset: () => Promise<void> }
  private readonly searchResultCount: number
  private readonly loaders: Map<string, BaseLoader> = new Map()

  constructor(private readonly builder: RAGApplicationBuilder) {
    this.embeddingModel = builder.getEmbeddingModel()
    this.vectorDatabase = builder.getVectorDatabase()
    this.searchResultCount = builder.getSearchResultCount()
  }

  public async init(): Promise<void> {
    await this.embeddingModel.init()
    await this.vectorDatabase.init({ dimensions: await this.embeddingModel.getDimensions() })
    for (const loader of this.builder.getLoaders()) {
      await this.addLoader(loader)
    }
  }

  public async reset(): Promise<void> {
    await this.vectorDatabase.reset()
    this.loaders.clear()
  }

  public async addLoader(loader: BaseLoader, forceReload = false): Promise<AddLoaderReturn> {
    const uniqueId = loader.getUniqueId()

    if (this.loaders.has(uniqueId)) {
      if (!forceReload) {
        return { entriesAdded: 0, uniqueId, loaderType: loader.constructor.name }
      }
      await this.deleteLoader(uniqueId)
    }

    await loader.init()

    let inserted = 0
    let index = 0
    let batch: Array<{ pageContent: string; metadata: Record<string, any> }> = []

    const flushBatch = async () => {
      if (batch.length === 0) return
      const texts = batch.map((c) => c.pageContent)
      const vectors = await this.embeddingModel.embedDocuments(texts)
      const formatted: VectorDbInsertChunk[] = batch.map((chunk, i) => {
        const id = `${uniqueId}_${index + i}`
        const source = (chunk.metadata?.source as string | undefined) ?? uniqueId
        return {
          pageContent: chunk.pageContent,
          vector: vectors[i],
          metadata: {
            ...chunk.metadata,
            id,
            uniqueLoaderId: uniqueId,
            source
          }
        }
      })
      inserted += await this.vectorDatabase.insertChunks(formatted)
      index += batch.length
      batch = []
    }

    for await (const chunk of loader.getChunks()) {
      batch.push({ pageContent: chunk.pageContent, metadata: chunk.metadata })
      if (batch.length >= DEFAULT_INSERT_BATCH_SIZE) {
        await flushBatch()
      }
    }
    await flushBatch()

    this.loaders.set(uniqueId, loader)
    return { entriesAdded: inserted, uniqueId, loaderType: loader.constructor.name }
  }

  public async deleteLoader(uniqueLoaderId: string): Promise<void> {
    await this.vectorDatabase.deleteKeys(uniqueLoaderId)
    this.loaders.delete(uniqueLoaderId)
  }

  public async search(query: string): Promise<SimilaritySearchResult[]> {
    const embedded = await this.embeddingModel.embedQuery(query)
    return this.vectorDatabase.similaritySearch(embedded, this.searchResultCount)
  }
}

