export default abstract class BaseEmbeddings {
  public async init(): Promise<void> {}
  public abstract getDimensions(): Promise<number>
  public abstract embedDocuments(texts: string[]): Promise<number[][]>
  public abstract embedQuery(text: string): Promise<number[]>
}

