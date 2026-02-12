import { Button, Card, CardBody, Input, Select, SelectItem, Switch, Textarea } from '@heroui/react'
import { useAppSelector } from '@renderer/store'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useAdaptiveScale } from '../workflow/components/useAdaptiveScale'
import { apiGet, apiPost, apiPut, ensureEndpoint, getWsBase, setGistVideoRuntimeConfig } from './apiClient'
import JobProgress from './components/JobProgress'
import LogPanel from './components/LogPanel'
import { pickOutputMp4 } from './dialog'
import type { JobEvent, Project } from './types'

type ProjectsResp = { projects: Project[] }
type StartJobResp = { job_id: string }

const pickOnePath = async (title: string, exts?: string[]): Promise<string | null> => {
  const files = await window.api.file.select({
    title,
    properties: ['openFile'],
    ...(exts && exts.length ? { filters: [{ name: 'Files', extensions: exts }] } : {})
  })
  const p = (files && files[0] && (files[0] as any).path) || ''
  return p ? String(p) : null
}

export default function RenderTab() {
  const providers = useAppSelector((s) => s.llm.providers)
  const { hostRef: layoutHostRef, scaledStyle } = useAdaptiveScale(1380)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string>('')

  const [audio, setAudio] = useState('')
  const [ttsJson, setTtsJson] = useState('')
  const [bgm, setBgm] = useState('')
  const [out, setOut] = useState('output.mp4')
  const [aspect, setAspect] = useState<'h' | 'v'>('h')
  const [keepSpeed, setKeepSpeed] = useState(true)
  const [emphEnable, setEmphEnable] = useState(true)
  const [emph, setEmph] = useState('')
  const [dedup, setDedup] = useState(60)
  const [script, setScript] = useState('')

  const [jobId, setJobId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState('空闲')
  const [pct, setPct] = useState(0)
  const [logs, setLogs] = useState<string[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const busy = !!jobId
  const selectedProject = useMemo(() => projects.find((p) => p.project_id === projectId) || null, [projects, projectId])

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
    ws.onerror = () => pushLog('WARNING: WebSocket 连接异常（可能后端未启动或端口不对）。')
  }

  const refreshProjects = async () => {
    const data = await apiGet<ProjectsResp>('/api/projects')
    setProjects(data.projects || [])
    if (!projectId && data.projects?.length) setProjectId(data.projects[0].project_id)
  }

  useEffect(() => {
    void refreshProjects().catch((e) => pushLog(`ERROR: ${String(e)}`))
    return () => stopWs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickAudio = async () => {
    const p = await pickOnePath('选择解说音频', ['mp3', 'wav', 'm4a', 'aac', 'flac'])
    if (!p) return
    setAudio(p)
    const base = p.replace(/\.[^/.]+$/, '')
    setTtsJson(`${base}.json`)
  }

  const pickTts = async () => {
    const p = await pickOnePath('选择时间轴 JSON', ['json'])
    if (p) setTtsJson(p)
  }

  const pickBgm = async () => {
    const p = await pickOnePath('选择背景音乐', ['mp3', 'wav', 'm4a', 'aac', 'flac'])
    if (p) setBgm(p)
  }

  const pickOut = async () => {
    const p = await pickOutputMp4(out)
    if (p) setOut(p)
  }

  const prepareVisionRuntime = async (): Promise<boolean> => {
    let providerId = ''
    let modelId = ''
    try {
      const raw = window.localStorage.getItem('gist-video.visionModelSelector.last.v1')
      if (raw) {
        const parsed = JSON.parse(raw) as any
        providerId = String(parsed?.provider || '').trim()
        modelId = String(parsed?.id || '').trim()
      }
    } catch {
      // ignore
    }

    if (!providerId || !modelId) {
      pushLog('ERROR: 未找到图生文模型选择。请先到「图生文设置」里选择模型并点击“应用配置”。')
      return false
    }

    const provider = providers.find((p) => p.id === providerId) || null
    if (!provider?.apiHost?.trim() || !provider?.apiKey?.trim()) {
      pushLog('ERROR: Provider 未配置 apiHost/apiKey。请到主程序「设置 → Provider」补全后再生成。')
      return false
    }

    setGistVideoRuntimeConfig({ visionApiBase: provider.apiHost, visionApiKey: provider.apiKey })
    await ensureEndpoint(true)

    try {
      await apiPut('/api/settings', { vision: { backend: 'auto', vision_model: modelId } })
    } catch (e) {
      pushLog(`WARNING: 写入 vision_model 失败：${String(e)}`)
    }

    return true
  }

  const startRender = async () => {
    if (!selectedProject || busy) return
    if (!audio.trim() || !script.trim() || !out.trim()) return

    const ok = await prepareVisionRuntime()
    if (!ok) return

    setLogs([])
    setPct(0)
    setStatus('正在生成视频...')
    const size = aspect === 'h' ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 }
    const emphList = emph
      .replace(/，/g, ',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const data = await apiPost<StartJobResp>('/api/jobs/render', {
      project_id: selectedProject.project_id,
      voice_audio_path: audio.trim(),
      script_text: script,
      output_path: out.trim(),
      tts_meta_path: ttsJson.trim() ? ttsJson.trim() : null,
      bgm_audio_path: bgm.trim() ? bgm.trim() : null,
      dedup_window_sec: Number(dedup || 60),
      output_width: size.w,
      output_height: size.h,
      keep_speed: !!keepSpeed,
      emphasis_enable: !!emphEnable,
      emphasis_phrases: emphList
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
    <div ref={layoutHostRef} className="w-full overflow-visible">
      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-6" style={scaledStyle}>
        <Card>
          <CardBody className="space-y-5 p-4">
            <div className="text-center">
              <h3 className="font-semibold text-lg">渲染配置</h3>
              <p className="text-foreground/55 text-sm">与助手页面使用一致的页面骨架与视觉层级。</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Select
                label="选择项目"
                labelPlacement="outside"
                selectedKeys={projectId ? [projectId] : []}
                onChange={(e) => setProjectId(String(e.target.value))}
                variant="flat"
                isDisabled={busy}
                classNames={{
                  trigger: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12',
                  value: 'text-base'
                }}>
                {projects.map((p) => (
                  <SelectItem key={p.project_id}>{p.name}</SelectItem>
                ))}
              </Select>

              <Select
                label="画面比例"
                labelPlacement="outside"
                selectedKeys={[aspect]}
                onChange={(e) => setAspect(e.target.value as 'h' | 'v')}
                variant="flat"
                isDisabled={busy}
                classNames={{
                  trigger: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12',
                  value: 'text-base'
                }}>
                <SelectItem key="h">横屏 16:9（1920x1080）</SelectItem>
                <SelectItem key="v">竖屏 9:16（1080x1920）</SelectItem>
              </Select>

              <Card className="border border-white/5 bg-content2/30">
                <CardBody className="flex flex-row items-center justify-between p-3">
                  <div>
                    <div className="font-medium text-sm">保持原速</div>
                    <div className="text-foreground/40 text-xs">启用后不会对视频片段做变速</div>
                  </div>
                  <Switch isSelected={keepSpeed} onValueChange={setKeepSpeed} isDisabled={busy} />
                </CardBody>
              </Card>

              <Card className="border border-white/5 bg-content2/30">
                <CardBody className="flex flex-row items-center justify-between p-3">
                  <div>
                    <div className="font-medium text-sm">启用花字</div>
                    <div className="text-foreground/40 text-xs">根据关键词或标记生成强调字幕</div>
                  </div>
                  <Switch isSelected={emphEnable} onValueChange={setEmphEnable} isDisabled={busy} />
                </CardBody>
              </Card>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <div className="text-foreground/45 text-xs">解说音频</div>
                <div className="flex gap-2">
                  <Input
                    value={audio}
                    onValueChange={setAudio}
                    placeholder="音频路径..."
                    isDisabled={busy}
                    variant="flat"
                    classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
                  />
                  <Button variant="flat" onPress={() => void pickAudio()} isDisabled={busy}>
                    浏览...
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-foreground/45 text-xs">时间轴 JSON（可选）</div>
                <div className="flex gap-2">
                  <Input
                    value={ttsJson}
                    onValueChange={setTtsJson}
                    placeholder="可留空；同名自动识别"
                    isDisabled={busy}
                    variant="flat"
                    classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
                  />
                  <Button variant="flat" onPress={() => void pickTts()} isDisabled={busy}>
                    浏览...
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-foreground/45 text-xs">背景音乐（可选）</div>
                <div className="flex gap-2">
                  <Input
                    value={bgm}
                    onValueChange={setBgm}
                    placeholder="BGM 路径..."
                    isDisabled={busy}
                    variant="flat"
                    classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
                  />
                  <Button variant="flat" onPress={() => void pickBgm()} isDisabled={busy}>
                    浏览...
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-foreground/45 text-xs">输出文件</div>
                <div className="flex gap-2">
                  <Input
                    value={out}
                    onValueChange={setOut}
                    placeholder="输出 mp4 路径..."
                    isDisabled={busy}
                    variant="flat"
                    classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
                  />
                  <Button variant="flat" onPress={() => void pickOut()} isDisabled={busy}>
                    另存为...
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="花字关键词"
                labelPlacement="outside"
                value={emph}
                onValueChange={setEmph}
                placeholder="执掌权柄,天才（也可 [[...]] 标记）"
                isDisabled={busy || !emphEnable}
                variant="flat"
                classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
              />

              <Input
                label="去重窗口（秒）"
                labelPlacement="outside"
                type="number"
                min={0}
                value={String(dedup)}
                onValueChange={(v) => setDedup(Math.max(0, Number(v || 0)))}
                isDisabled={busy}
                variant="flat"
                classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-5 p-4">
            <div className="space-y-2 text-center">
              <h3 className="font-semibold text-lg">文案与任务状态</h3>
              <p className="text-foreground/55 text-sm">输入文案后即可生成；支持暂停与取消。</p>
            </div>

            <div className="space-y-2">
              <div className="text-center text-foreground/60 text-sm">解说文案</div>
              <Textarea
                value={script}
                onValueChange={setScript}
                placeholder="在这里粘贴解说文案..."
                isDisabled={busy}
                variant="bordered"
                minRows={10}
                classNames={{ inputWrapper: 'bg-content2/20' }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                color="primary"
                onPress={() => void startRender()}
                isDisabled={!selectedProject || busy || !audio.trim() || !script.trim() || !out.trim()}>
                开始生成 MP4
              </Button>
              <Button variant="flat" onPress={() => void pauseOrResume()} isDisabled={!jobId}>
                {paused ? '继续' : '暂停'}
              </Button>
              <Button color="danger" variant="flat" onPress={() => void cancel()} isDisabled={!jobId}>
                取消
              </Button>
            </div>

            <JobProgress pct={pct} stage={status} />
            <LogPanel lines={logs} />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
