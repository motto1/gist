import type { GistVideoEndpoint } from './types'

let endpointPromise: Promise<GistVideoEndpoint> | null = null

export async function ensureEndpoint(force: boolean = false): Promise<GistVideoEndpoint> {
  if (force || !endpointPromise) {
    endpointPromise = window.api.gistVideo.ensureBackend() as Promise<GistVideoEndpoint>
  }
  return endpointPromise
}

async function readJsonOrThrow(r: Response) {
  const text = await r.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg =
      // FastAPI default
      (data as any)?.detail ??
      // our own error format
      (data as any)?.error ??
      `${r.status} ${r.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`
    throw new Error(String(msg))
  }
  return data
}

export async function apiGet<T>(path: string): Promise<T> {
  const { baseUrl } = await ensureEndpoint()
  const r = await fetch(`${baseUrl}${path}`, { method: 'GET' })
  return (await readJsonOrThrow(r)) as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const { baseUrl } = await ensureEndpoint()
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return (await readJsonOrThrow(r)) as T
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const { baseUrl } = await ensureEndpoint()
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return (await readJsonOrThrow(r)) as T
}

export async function getWsBase(): Promise<string> {
  const { wsBase } = await ensureEndpoint()
  return wsBase
}

