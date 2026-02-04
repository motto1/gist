import { Button, Card, CardBody, Chip, Input, Select, SelectItem } from '@heroui/react'
import { useEffect, useMemo, useState } from 'react'

import { apiGet, apiPost, apiPut } from './apiClient'
import LogPanel from './components/LogPanel'
import { pickImages } from './dialog'
import type { SettingsResponse } from './types'

type ModelsResp = { models: string[] }
type CaptionResp = { captions: string[] }

function fmtTime(ts: number | null) {
  if (!ts) return 'null'
  return new Date(ts * 1000).toLocaleString()
}

export default function ApiSettingsTab() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const [backend, setBackend] = useState('auto')
  const [apiBase, setApiBase] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [workers, setWorkers] = useState(2)
  const [inFlight, setInFlight] = useState(8)
  const [skipHead, setSkipHead] = useState(0)
  const [skipTail, setSkipTail] = useState(0)

  const [modelChoices, setModelChoices] = useState<string[]>([])
  const canFetchModels = useMemo(() => backend === 'auto' || backend === 'gemini_proxy', [backend])

  const pushLog = (line: string) => {
    setLogs((prev) => {
      const next = [...prev, line]
      return next.length > 2000 ? next.slice(next.length - 2000) : next
    })
  }

  const applyFrom = (s: SettingsResponse) => {
    setBackend(String(s.settings.vision.backend || 'auto'))
    setApiBase(String(s.settings.vision.api_base || ''))
    setApiKey(String(s.settings.vision.api_key || ''))
    setVisionModel(String(s.settings.vision.vision_model || ''))
    setWorkers(Number(s.settings.vision.caption_workers || 2))
    setInFlight(Number(s.settings.vision.caption_in_flight || 8))
    setSkipHead(Number((s.settings.vision as any).skip_head_sec ?? 0))
    setSkipTail(Number((s.settings.vision as any).skip_tail_sec ?? 0))
  }

  const reload = async (showDivider: boolean = true) => {
    const s = await apiGet<SettingsResponse>('/api/settings')
    setSettings(s)
    applyFrom(s)
    if (showDivider) pushLog('----')
    pushLog(`加载路径：${s.path}`)
    pushLog(`存在：${String(s.exists)}`)
    pushLog(`mtime：${fmtTime(s.mtime)}`)
    pushLog(`root：${s.root}`)
    pushLog(`已加载：skip_head_sec=${String(s.settings.vision.skip_head_sec)}, skip_tail_sec=${String(s.settings.vision.skip_tail_sec)}`)
  }

  useEffect(() => {
    void reload(false).catch((e) => pushLog(`ERROR: ${String(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    const payload = {
      vision: {
        backend,
        api_base: apiBase,
        api_key: apiKey,
        vision_model: visionModel,
        caption_workers: Number(workers),
        caption_in_flight: Number(inFlight),
        skip_head_sec: Number(skipHead),
        skip_tail_sec: Number(skipTail)
      }
    }
    const s = await apiPut<SettingsResponse>('/api/settings', payload)
    setSettings(s)
    applyFrom(s)
    pushLog(`保存成功：${s.saved_to || s.path}`)
  }

  const fetchModels = async () => {
    if (!canFetchModels) return
    const s = await apiPost<ModelsResp>('/api/vision/models', { api_base: apiBase, api_key: apiKey })
    setModelChoices(s.models || [])
    pushLog(`获取模型列表成功：${(s.models || []).length} 个`)
  }

  const testCaption = async () => {
    const paths = await pickImages(3)
    if (paths.length !== 3) {
      pushLog('WARNING: 需要一次选择 3 张图片。')
      return
    }
    const r = await apiPost<CaptionResp>('/api/vision/test-caption', {
      image_paths: paths,
      api_base: apiBase,
      api_key: apiKey,
      vision_model: visionModel
    })
    pushLog('测试图生文结果：')
    for (const [i, c] of (r.captions || []).entries()) {
      pushLog(`${i}: ${c}`)
    }
  }

  return (
    <Card className="bg-content1/50 border border-white/5 shadow-sm backdrop-blur-md">
      <CardBody className="space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Select
            label="图生文方式"
            labelPlacement="outside"
            selectedKeys={[backend]}
            onChange={(e) => setBackend(e.target.value)}
            variant="flat"
            classNames={{ trigger: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12', value: 'text-base' }}
          >
            <SelectItem key="auto">自动（已配置则使用 API；否则关闭）</SelectItem>
            <SelectItem key="gemini_proxy">Gemini/第三方中转站（OpenAI 兼容）</SelectItem>
            <SelectItem key="null">关闭图生文（不推荐）</SelectItem>
          </Select>

          <Input
            label="并发线程数"
            labelPlacement="outside"
            type="number"
            min={1}
            max={16}
            value={String(workers)}
            onValueChange={(v) => setWorkers(Math.max(1, Math.min(16, Number(v || 1))))}
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />

          <Input
            className="lg:col-span-2"
            label="中转站地址"
            labelPlacement="outside"
            value={apiBase}
            onValueChange={setApiBase}
            placeholder="例如：https://YOUR-RELAY-HOST/v1"
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />

          <Input
            className="lg:col-span-2"
            label="密钥"
            labelPlacement="outside"
            type="password"
            value={apiKey}
            onValueChange={setApiKey}
            placeholder="粘贴你的密钥"
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />

          <div className="lg:col-span-2 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-foreground/60 text-sm">Vision 模型</div>
              <Button size="sm" variant="flat" onPress={() => void fetchModels()} isDisabled={!canFetchModels}>
                获取模型列表
              </Button>
            </div>

            <Input
              value={visionModel}
              onValueChange={setVisionModel}
              placeholder="例如：gpt-4o / gemini-1.5-pro / 以中转站实际模型名为准"
              variant="flat"
              classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
            />

            {modelChoices.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {modelChoices.slice(0, 18).map((m) => (
                  <Chip
                    key={m}
                    size="sm"
                    variant="flat"
                    className="cursor-pointer"
                    onClick={() => setVisionModel(m)}
                  >
                    {m}
                  </Chip>
                ))}
                {modelChoices.length > 18 ? (
                  <span className="text-foreground/40 text-xs">仅展示前 18 个（仍可手动输入）</span>
                ) : null}
              </div>
            ) : null}
          </div>

          <Input
            label="最大排队请求"
            labelPlacement="outside"
            type="number"
            min={1}
            max={256}
            value={String(inFlight)}
            onValueChange={(v) => setInFlight(Math.max(1, Math.min(256, Number(v || 1))))}
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />

          <Input
            label="跳过片头（秒）"
            labelPlacement="outside"
            type="number"
            min={0}
            max={3600}
            value={String(skipHead)}
            onValueChange={(v) => setSkipHead(Math.max(0, Math.min(3600, Number(v || 0))))}
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />

          <Input
            label="跳过片尾（秒）"
            labelPlacement="outside"
            type="number"
            min={0}
            max={3600}
            value={String(skipTail)}
            onValueChange={(v) => setSkipTail(Math.max(0, Math.min(3600, Number(v || 0))))}
            variant="flat"
            classNames={{ inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12' }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button color="primary" onPress={() => void save()}>
            保存设置
          </Button>
          <Button variant="flat" onPress={() => void reload(true)}>
            重新加载
          </Button>
          <Button variant="flat" onPress={() => void testCaption()}>
            测试图生文（选 3 张图）
          </Button>
          <div className="ml-auto text-foreground/40 text-xs">
            {settings ? `settings.json: ${settings.path}` : 'settings.json: ...'}
          </div>
        </div>

        <div className="text-foreground/50 text-sm">
          说明：建库时会对每个切片的 3 帧做图生文，并写入索引用于后续匹配（会缓存结果避免重复扣费）。
        </div>

        <LogPanel lines={logs} />
      </CardBody>
    </Card>
  )
}
