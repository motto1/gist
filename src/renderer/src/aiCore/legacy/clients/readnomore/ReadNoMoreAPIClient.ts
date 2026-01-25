import type { Model, Provider } from '@renderer/types'
import OpenAI from 'openai'

import { OpenAIAPIClient } from '../openai/OpenAIApiClient'

export class ReadNoMoreAPIClient extends OpenAIAPIClient {
  constructor(provider: Provider) {
    super(provider)
  }

  override getClientCompatibilityType(): string[] {
    return ['ReadNoMoreAPIClient']
  }

  public async listModels(): Promise<OpenAI.Models.Model[]> {
    const models = (this.provider.models ?? []) as Model[]
    const created = Date.now()

    return models.map((model) => ({
      id: model.id,
      owned_by: 'readnomore',
      object: 'model' as const,
      created
    }))
  }
}
