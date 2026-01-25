import type BaseEmbeddings from '../embeddings/BaseEmbeddings'
import type BaseLoader from '../loaders/BaseLoader'
import type { LibSqlDb } from '../vector/LibSqlDb'
import RAGApplication from './RAGApplication'

export default class RAGApplicationBuilder {
  private vectorDatabase?: LibSqlDb
  private embeddingModel?: BaseEmbeddings
  private searchResultCount = 30
  private loaders: BaseLoader[] = []

  public setVectorDatabase(vectorDatabase: LibSqlDb): this {
    this.vectorDatabase = vectorDatabase
    return this
  }

  public setEmbeddingModel(embeddingModel: BaseEmbeddings): this {
    this.embeddingModel = embeddingModel
    return this
  }

  public setSearchResultCount(searchResultCount: number): this {
    this.searchResultCount = searchResultCount
    return this
  }

  public addLoader(loader: BaseLoader): this {
    this.loaders.push(loader)
    return this
  }

  public setModel(_model: unknown): this {
    return this
  }

  public getVectorDatabase(): LibSqlDb {
    if (!this.vectorDatabase) throw new Error('vectorDatabase not set')
    return this.vectorDatabase
  }

  public getEmbeddingModel(): BaseEmbeddings {
    if (!this.embeddingModel) throw new Error('embeddingModel not set')
    return this.embeddingModel
  }

  public getSearchResultCount(): number {
    return this.searchResultCount
  }

  public getLoaders(): BaseLoader[] {
    return this.loaders
  }

  public async build(): Promise<RAGApplication> {
    const entity = new RAGApplication(this)
    await entity.init()
    return entity
  }
}

