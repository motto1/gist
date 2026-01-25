import { type Client,createClient } from '@libsql/client'

import type { SimilaritySearchResult, VectorDbInitParams, VectorDbInsertChunk } from '../types'
import { truncateCenterString } from '../utils/string'

const sanitizeSqlIdentifier = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`)
  }
  return value
}

export class LibSqlDb {
  private readonly tableName: string
  private readonly client: Client

  constructor({ path, tableName }: { path: string; tableName?: string }) {
    this.tableName = sanitizeSqlIdentifier(tableName ?? 'vectors')
    this.client = createClient({ url: `file:${path}` })
  }

  public async init({ dimensions }: VectorDbInitParams): Promise<void> {
    const vectorColumnType = dimensions ? `F32_BLOB(${dimensions})` : 'F32_BLOB'
    await this.client.execute(`CREATE TABLE IF NOT EXISTS ${this.tableName} (
      id              TEXT PRIMARY KEY,
      pageContent     TEXT UNIQUE,
      uniqueLoaderId  TEXT NOT NULL,
      source          TEXT NOT NULL,
      vector          ${vectorColumnType},
      metadata        TEXT
    );`)
  }

  public async insertChunks(chunks: VectorDbInsertChunk[]): Promise<number> {
    if (chunks.length === 0) return 0
    const batch = chunks.map((chunk) => {
      const vectorLiteral = `[${chunk.vector.join(',')}]`
      return {
        sql: `INSERT OR IGNORE INTO ${this.tableName} (id, pageContent, uniqueLoaderId, source, vector, metadata)
          VALUES (?, ?, ?, ?, vector32('${vectorLiteral}'), ?);`,
        args: [
          chunk.metadata.id,
          chunk.pageContent,
          chunk.metadata.uniqueLoaderId,
          chunk.metadata.source,
          JSON.stringify(chunk.metadata)
        ]
      }
    })

    const result = await this.client.batch(batch, 'write')
    return result.reduce((sum, item) => sum + item.rowsAffected, 0)
  }

  public async similaritySearch(query: number[], k: number): Promise<SimilaritySearchResult[]> {
    const vectorLiteral = `[${query.join(',')}]`
    const statement = `SELECT id, pageContent, uniqueLoaderId, source, metadata,
        vector_distance_cos(vector, vector32('${vectorLiteral}')) as distance
      FROM ${this.tableName}
      ORDER BY vector_distance_cos(vector, vector32('${vectorLiteral}')) ASC
      LIMIT ${k};`

    const results = await this.client.execute(statement)
    return results.rows.map((row) => {
      const metadata = JSON.parse((row.metadata?.toString() ?? '{}') as string)
      return {
        metadata,
        pageContent: (row.pageContent?.toString() ?? '') as string,
        score: 1 - Number(row.distance ?? 1)
      }
    })
  }

  public async deleteKeys(uniqueLoaderId: string): Promise<boolean> {
    await this.client.execute({ sql: `DELETE FROM ${this.tableName} WHERE uniqueLoaderId = ?;`, args: [uniqueLoaderId] })
    return true
  }

  public async reset(): Promise<void> {
    await this.client.execute(`DELETE FROM ${this.tableName};`)
  }

  public async getAllChunks(): Promise<Array<{ pageContent: string; metadata: Record<string, any> }>> {
    const statement = `SELECT pageContent, metadata FROM ${this.tableName}`
    const results = await this.client.execute(statement)
    return results.rows.map((row) => ({
      pageContent: (row.pageContent?.toString() ?? '') as string,
      metadata: JSON.parse((row.metadata?.toString() ?? '{}') as string)
    }))
  }

  public toString(): string {
    return truncateCenterString(`[LibSqlDb:${this.tableName}]`, 80)
  }
}
