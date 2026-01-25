export type Chunk = {
  pageContent: string
  metadata: Record<string, any>
}

export type ChunkWithHash = Chunk & {
  contentHash: string
}

export type AddLoaderReturn = {
  entriesAdded: number
  uniqueId: string
  loaderType: string
}

export type SimilaritySearchResult = {
  pageContent: string
  score: number
  metadata: Record<string, any>
}

export type VectorDbInitParams = {
  dimensions?: number
}

export type VectorDbInsertChunk = {
  pageContent: string
  vector: number[]
  metadata: Record<string, any> & {
    id: string
    uniqueLoaderId: string
    source: string
  }
}

