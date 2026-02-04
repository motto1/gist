import { Button, Card, CardBody, Input } from '@heroui/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { apiGet, apiPost, getWsBase } from './apiClient'
import LogPanel from './components/LogPanel'
import JobProgress from './components/JobProgress'
import { pickVideos } from './dialog'
import type { JobEvent, Project } from './types'

type ProjectsResp = { projects: Project[] }
type CreateProjectResp = { project: Project }
type StartJobResp = { job_id: string }

function ts(sec: number) {
  const d = new Date(Number(sec || 0) * 1000)
  return d.toLocaleString()
}

export default function ProjectLibraryTab() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [maxVideos, setMaxVideos] = useState<number>(0)

  const [jobId, setJobId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState('空闲')
  const [pct, setPct] = useState(0)
  const [logs, setLogs] = useState<string[]>([])

  const wsRef = useRef<WebSocket | null>(null)

  const busy = !!jobId
  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selected) || null,
    [projects, selected]
  )

  const pushLog = (line: string) => {
    setLogs((prev) => {
      const next = [...prev, line]
      return next.length > 2000 ? next.slice(next.length - 2000) : next
    })
  }

  const stopWs = () => {
    try {
      wsRef.current?.close()
    } catch {
      // ignore
    }
    wsRef.current = null
  }

  const handleEvent = (msg: JobEvent) => {
    if (msg.type === 'progress') {
      setPct(Number((msg as any).pct || 0))
      setStatus(String((msg as any).stage || ''))
      return
    }
    if (msg.type === 'log') {
      pushLog(String((msg as any).message || ''))
      return
    }
    if (msg.type === 'state') {
      const s = String((msg as any).status || '')
      if (s) setStatus(s)
      setPaused(s === 'paused')
      return
    }
    if (msg.type === 'error') {
      pushLog(String((msg as any).error || 'ERROR'))
      setStatus('failed')
      setJobId(null)
      stopWs()
      return
    }
    if (msg.type === 'done') {
      const s = String((msg as any).status || 'done')
      setStatus(s)
      setJobId(null)
      stopWs()
      pushLog('完成。')
      void refreshProjects()
      return
    }
  }

  const bindWs = async (newJobId: string) => {
    stopWs()
    const wsBase = await getWsBase()
    const ws = new WebSocket(`${wsBase}/ws/jobs/${newJobId}`)
    wsRef.current = ws
    ws.onmessage = (ev) => {
      let raw: any = null
      try {
        raw = JSON.parse(ev.data)
      } catch {
        return
      }
      if (!raw || typeof raw.type !== 'string') return
      if (raw.type === 'snapshot') {
        setStatus(raw.job?.stage || raw.job?.status || '运行中')
        setPct(Number(raw.job?.progress_pct || 0))
        setPaused(raw.job?.status === 'paused')
        for (const e2 of raw.events || []) handleEvent(e2 as JobEvent)
        return
      }
      handleEvent(raw as JobEvent)
    }
    ws.onerror = () => {
      pushLog('WARNING: WebSocket 连接异常（可能后端未启动或端口不对）。')
    }
  }

  const refreshProjects = async () => {
    const data = await apiGet<ProjectsResp>('/api/projects')
    setProjects(data.projects || [])
    if (selected && !(data.projects || []).some((p) => p.project_id === selected)) {
      setSelected(null)
    }
  }

  useEffect(() => {
    void refreshProjects().catch((e) => pushLog(`ERROR: ${String(e)}`))
    return () => stopWs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createProject = async () => {
    const name = newName.trim()
    if (!name) return
    const data = await apiPost<CreateProjectResp>('/api/projects', { name })
    setNewName('')
    await refreshProjects()
    setSelected(data.project.project_id)
  }

  const addVideos = async () => {
    if (!selectedProject || busy) return
    const paths = await pickVideos()
    if (!paths.length) return
    await apiPost(`/api/projects/${selectedProject.project_id}/videos`, { video_paths: paths })
    pushLog(`已添加 ${paths.length} 个视频。`)
  }

  const startIndex = async () => {
    if (!selectedProject || busy) return
    setLogs([])
    setPct(0)
    setStatus('正在建立索引...')
    const data = await apiPost<StartJobResp>('/api/jobs/index', {
      project_id: selectedProject.project_id,
      frames_per_clip: 3,
      max_videos: Number(maxVideos || 0)
    })
    setJobId(data.job_id)
    setPaused(false)
    await bindWs(data.job_id)
  }

  const pauseOrResume = async () => {
    if (!jobId) return
    if (paused) await apiPost(`/api/jobs/${jobId}/resume`)
    else await apiPost(`/api/jobs/${jobId}/pause`)
  }

  const cancel = async () => {
    if (!jobId) return
    await apiPost(`/api/jobs/${jobId}/cancel`)
    setStatus('正在取消...')
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card className="bg-content1/50 border border-white/5 shadow-sm backdrop-blur-md">
        <CardBody className="space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onValueChange={setNewName}
              placeholder="输入项目名称..."
              isDisabled={busy}
              variant="flat"
              classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
            />
            <Button color="primary" onPress={() => void createProject()} isDisabled={busy || !newName.trim()}>
              新建项目
            </Button>
            <Button variant="flat" onPress={() => void refreshProjects()} isDisabled={busy}>
              刷新
            </Button>
          </div>

          <div className="text-foreground/60 text-sm">项目列表</div>
          <div className="flex max-h-[420px] flex-col gap-2 overflow-auto">
            {projects.map((p) => {
              const active = p.project_id === selected
              return (
                <button
                  key={p.project_id}
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected(p.project_id)}
                  className={[
                    'text-left',
                    'rounded-lg border p-3 transition-colors',
                    active ? 'border-primary/60 bg-content2' : 'border-divider bg-content1',
                    busy ? 'opacity-60' : 'hover:bg-content2'
                  ].join(' ')}
                >
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="mt-1 text-foreground/40 text-xs">
                    {p.project_id} · {ts(p.created_at)}
                  </div>
                </button>
              )
            })}
            {!projects.length ? (
              <div className="rounded-lg border border-dashed border-divider p-4 text-foreground/40 text-sm">
                暂无项目
              </div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card className="bg-content1/50 border border-white/5 shadow-sm backdrop-blur-md">
        <CardBody className="space-y-5 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="flat" onPress={() => void addVideos()} isDisabled={!selectedProject || busy}>
              添加视频...
            </Button>

            <div className="flex items-center gap-2">
              <span className="text-foreground/60 text-sm">本次处理前 N 个视频</span>
              <Input
                type="number"
                min={0}
                value={String(maxVideos)}
                onValueChange={(v) => setMaxVideos(Math.max(0, Number(v || 0)))}
                isDisabled={busy}
                variant="flat"
                className="w-[160px]"
                classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
              />
            </div>

            <Button color="primary" onPress={() => void startIndex()} isDisabled={!selectedProject || busy}>
              建立/更新索引
            </Button>
            <Button variant="flat" onPress={() => void pauseOrResume()} isDisabled={!jobId}>
              {paused ? '继续' : '暂停'}
            </Button>
            <Button color="danger" variant="flat" onPress={() => void cancel()} isDisabled={!jobId}>
              取消
            </Button>
          </div>

          <JobProgress pct={pct} stage={status} />

          <div className="text-foreground/50 text-sm">
            说明：建库会生成 proxy、抽帧、图生文缓存、最后做文本向量化并写入 index。
          </div>

          <LogPanel lines={logs} />
        </CardBody>
      </Card>
    </div>
  )
}
