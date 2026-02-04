export type GistVideoEndpoint = {
  baseUrl: string
  wsBase: string
  port: number
  pid: number
  dataDir: string
  backendRoot: string
  startedAt: number
}

export type Project = {
  project_id: string
  name: string
  created_at: number
}

export type SettingsMeta = {
  path: string
  exists: boolean
  mtime: number | null
  root: string
}

export type AppSettings = {
  embedding: {
    backend: string
    model_id: string
  }
  vision: {
    backend: string
    api_base: string
    api_key: string
    vision_model: string
    caption_workers: number
    caption_in_flight: number
    caption_batch_clips: number
    caption_batch_max_images: number
    skip_head_sec: number
    skip_tail_sec: number
    slice_mode: string
    scene_threshold: number
    scene_fps: number
    clip_min_sec: number
    clip_target_sec: number
    clip_max_sec: number
  }
  render: Record<string, unknown>
}

export type SettingsResponse = SettingsMeta & { settings: AppSettings; saved_to?: string }

export type JobSnapshot = {
  job_id: string
  kind: 'index' | 'render' | string
  status: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  progress_pct: number
  stage: string
  error: string | null
}

export type JobEvent =
  | { type: 'snapshot'; job: JobSnapshot; events: JobEvent[] }
  | { type: 'progress'; ts: number; pct: number; stage: string }
  | { type: 'log'; ts: number; message: string }
  | { type: 'state'; ts: number; status: string }
  | { type: 'error'; ts: number; error: string }
  | { type: 'done'; ts: number; status: string }
  | { type: string; [k: string]: unknown }

