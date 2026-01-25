export type LayoutToken =
  | { kind: 'title'; text: string; height: number }
  | { kind: 'body'; text: string; height: number }
  | { kind: 'space'; height: number }

export type LayoutPayload = {
  title: string
  body: string
  width: number
  height: number
  paddingLeft: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  titleFontSize: number
  titleLineHeight: number
  titleBottomSpacing: number
  paragraphSpacing: number
}

type LayoutRequest = { id: number; type: 'layout'; payload: LayoutPayload }
type LayoutResponse =
  | { id: number; type: 'result'; result: { pages: LayoutToken[][] } }
  | { id: number; type: 'error'; error: string }

class TextLayoutService {
  private worker: Worker | null = null
  private workerInitPromise: Promise<void> | null = null
  private requestId = 0
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: { pages: LayoutToken[][] }) => void
      reject: (reason?: unknown) => void
      timerId?: number
    }
  >()

  private async ensureWorker() {
    if (this.worker) return
    if (this.workerInitPromise) return this.workerInitPromise

    this.workerInitPromise = (async () => {
      const WorkerModule = await import('../workers/text-layout.worker?worker')
      this.worker = new WorkerModule.default()

      this.worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        const data = event.data
        const pending = this.pendingRequests.get(data.id)
        if (!pending) return

        this.pendingRequests.delete(data.id)
        if (pending.timerId) window.clearTimeout(pending.timerId)

        if (data.type === 'error') {
          pending.reject(new Error(data.error))
        } else {
          pending.resolve(data.result)
        }
      }
    })()
      .finally(() => {
        this.workerInitPromise = null
      })

    return this.workerInitPromise
  }

  public async layout(payload: LayoutPayload): Promise<{ pages: LayoutToken[][] }> {
    await this.ensureWorker()
    if (!this.worker) throw new Error('TextLayout worker 未初始化')

    const id = ++this.requestId
    const message: LayoutRequest = { id, type: 'layout', payload }

    return await new Promise<{ pages: LayoutToken[][] }>((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('TextLayout worker request timeout'))
      }, 20_000)

      this.pendingRequests.set(id, { resolve, reject, timerId })
      this.worker?.postMessage(message)
    })
  }
}

export const textLayoutService = new TextLayoutService()

