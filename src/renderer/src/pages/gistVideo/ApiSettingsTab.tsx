import { Button, Chip, Input, Select, SelectItem } from '@heroui/react'
import type { Model } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { isVisionModel } from '@renderer/config/models'
import { useAllProviders } from '@renderer/hooks/useProvider'
import type { Provider } from '@renderer/types'

import { GlassPanel, VisionModelSelector } from '../workflow/components'
import { apiGet, apiPost, apiPut, ensureEndpoint, setGistVideoRuntimeConfig } from './apiClient'
import LogPanel from './components/LogPanel'
import { pickImages } from './dialog'
import type { SettingsResponse } from './types'

type ModelsResp = { models: string[] }
type CaptionResp = { captions: string[] }

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function fmtTime(ts: number | null) {
  if (!ts) return 'null'
  return new Date(ts * 1000).toLocaleString()
}

function maskApiKey(apiKey: string) {
  const key = String(apiKey || '').trim()
  if (!key) return '未配置'
  if (key.length <= 8) return `${key.slice(0, 2)}***${key.slice(-2)}`
  return `${key.slice(0, 4)}***${key.slice(-4)}`
}

function isProviderReady(provider: Provider | null): boolean {
  if (!provider) return false
  return isNonEmptyString(provider.apiHost) && isNonEmptyString(provider.apiKey)
}

export default function ApiSettingsTab() {
  const navigate = useNavigate()
  const providers = useAllProviders()

  const [selectedModel, setSelectedModel] = useState<Model | null>(null)

  const selectedProvider = useMemo(() => {
    const providerId = selectedModel?.provider
    if (!providerId) return null
    return providers.find((p) => p.id === providerId) || null
  }, [providers, selectedModel?.provider])

  const providerReady = isProviderReady(selectedProvider)

  const [settingsMeta, setSettingsMeta] = useState<{ path: string; exists: boolean; mtime: number | null } | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const [backend, setBackend] = useState('auto')
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
    setSettingsMeta({ path: s.path, exists: s.exists, mtime: s.mtime })
    setBackend(String(s.settings.vision.backend || 'auto'))
    setVisionModel(String(s.settings.vision.vision_model || ''))
    setWorkers(Number(s.settings.vision.caption_workers || 2))
    setInFlight(Number(s.settings.vision.caption_in_flight || 8))
    setSkipHead(Number((s.settings.vision as any).skip_head_sec ?? 0))
    setSkipTail(Number((s.settings.vision as any).skip_tail_sec ?? 0))
  }

  const reload = async (showDivider: boolean = true) => {
    const s = await apiGet<SettingsResponse>('/api/settings')
    applyFrom(s)
    if (showDivider) pushLog('----')
    pushLog(`加载路径：${s.path}`)
    pushLog(`存在：${String(s.exists)}`)
    pushLog(`mtime：${fmtTime(s.mtime)}`)
    pushLog(`root：${s.root}`)
  }

  useEffect(() => {
    void reload(false).catch((e) => pushLog(`ERROR: ${String(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyToBackend = async () => {
    if (!selectedModel) return
    if (!selectedProvider) return
    if (!providerReady) {
      pushLog('ERROR: Provider 未配置 apiHost/apiKey，请先到主程序 Provider 设置中补全。')
      return
    }

    // 1) Push credentials to backend (runtime-only, in-memory on python side)
    setGistVideoRuntimeConfig({
      visionApiBase: selectedProvider.apiHost,
      visionApiKey: selectedProvider.apiKey
    })

    // Ensure backend is running and runtime config is applied.
    await ensureEndpoint(true)

    // 2) Persist only non-sensitive settings (model + concurrency knobs)
    const resolvedVisionModel = (visionModel || selectedModel.id).trim()

    const payload = {
      vision: {
        backend,
        // Prefer user-selected model string (can be overridden by the fetched list chips).
        vision_model: resolvedVisionModel,
        caption_workers: Number(workers),
        caption_in_flight: Number(inFlight),
        skip_head_sec: Number(skipHead),
        skip_tail_sec: Number(skipTail)
      }
    }

    const s = await apiPut<SettingsResponse>('/api/settings', payload)
    applyFrom(s)

    pushLog('已应用配置（凭据来自主程序 Provider，通过 env 注入后端，不会写入 settings.json）。')
  }

  const fetchModels = async () => {
    if (!canFetchModels) return
    if (!selectedProvider || !providerReady) return

    // Ensure backend is running and runtime config is applied.
    setGistVideoRuntimeConfig({ visionApiBase: selectedProvider.apiHost, visionApiKey: selectedProvider.apiKey })
    await ensureEndpoint(true)

    const s = await apiPost<ModelsResp>('/api/vision/models', {})
    setModelChoices(s.models || [])
    pushLog(`获取模型列表成功：${(s.models || []).length} 个`)
  }

  const testCaption = async () => {
    if (!selectedProvider || !providerReady) {
      pushLog('ERROR: Provider 未配置 apiHost/apiKey。')
      return
    }

    const paths = await pickImages(3)
    if (paths.length !== 3) {
      pushLog('WARNING: 需要一次选择 3 张图片。')
      return
    }

    setGistVideoRuntimeConfig({ visionApiBase: selectedProvider.apiHost, visionApiKey: selectedProvider.apiKey })
    await ensureEndpoint(true)

    const model = (selectedModel?.id || visionModel || '').trim()
    if (!model) {
      pushLog('ERROR: 缺少 vision_model。')
      return
    }

    const r = await apiPost<CaptionResp>('/api/vision/test-caption', {
      image_paths: paths,
      vision_model: model
    })

    pushLog('测试图生文结果：')
    for (const [i, c] of (r.captions || []).entries()) {
      pushLog(`${i}: ${c}`)
    }
  }

  const providerHint = useMemo(() => {
    if (!selectedProvider) return '未选择 Provider'
    const base = selectedProvider.apiHost || '未配置'
    const key = maskApiKey(selectedProvider.apiKey)
    return `Base: ${base} · Key: ${key}`
  }, [selectedProvider])

  return (
    <GlassPanel paddingClassName="p-6" className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <VisionModelSelector
            selectedModel={selectedModel}
            onModelSelect={(m) => {
              setSelectedModel(m)
              // Always use the selected model id by default; user can override via fetched list below.
              setVisionModel(m.id)
            }}
            storageKey="gist-video.visionModelSelector.last.v1"
            label="选择模型（建议选择 Vision）"
          />
        </div>

        <GlassPanel radiusClassName="rounded-2xl" paddingClassName="px-4 py-3" className="space-y-1 lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-foreground text-sm">主程序 Provider 配置（只读）</div>
            <Button
              size="sm"
              variant="flat"
              onPress={() => navigate(`/settings/provider${selectedProvider?.id ? `?id=${encodeURIComponent(selectedProvider.id)}` : ''}`)}
            >
              打开 Provider 设置
            </Button>
          </div>
          <div className="text-foreground/50 text-xs">{providerHint}</div>
          <div className="text-foreground/40 text-xs">
            说明：API 凭据由主程序通过 IPC 传给视频后端，并写入后端内存（runtime-only），不会落盘到 settings.json。
          </div>
        </GlassPanel>

        {!providerReady ? (
          <GlassPanel
            radiusClassName="rounded-2xl"
            paddingClassName="p-4"
            className="space-y-2 border-warning-200 bg-warning-50 lg:col-span-2"
          >
            <div className="font-medium text-warning-700">Provider 配置不完整</div>
            <div className="text-warning-700/80 text-sm">请先在主程序 Provider 设置中补全 apiHost / apiKey。</div>
          </GlassPanel>
        ) : selectedModel && !isVisionModel(selectedModel) ? (
          <GlassPanel
            radiusClassName="rounded-2xl"
            paddingClassName="p-4"
            className="space-y-2 border-warning-200 bg-warning-50 lg:col-span-2"
          >
            <div className="font-medium text-warning-700">当前模型可能不支持图生文（非 Vision）</div>
            <div className="text-warning-700/80 text-sm">
              你仍然可以尝试使用该模型（部分中转站可能支持图片输入但命名不匹配），若失败请切换到标记为“Vision”的模型。
            </div>
          </GlassPanel>
        ) : null}

        <Select
          label="图生文方式"
          labelPlacement="outside"
          selectedKeys={[backend]}
          onChange={(e) => setBackend(e.target.value)}
          variant="flat"
          classNames={{ trigger: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12', value: 'text-base' }}
        >
          <SelectItem key="auto">自动（已配置则使用 API；否则关闭）</SelectItem>
          <SelectItem key="gemini_proxy">第三方中转站（OpenAI 兼容）</SelectItem>
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

        <div className="lg:col-span-2 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-foreground/60 text-sm">Vision 模型（后端可见的模型列表）</div>
            <Button size="sm" variant="flat" onPress={() => void fetchModels()} isDisabled={!providerReady || !canFetchModels}>
              获取模型列表
            </Button>
          </div>

          <div className="text-foreground/40 text-xs">
            当前：{(selectedModel?.id || visionModel || '').trim() || '未选择'}
          </div>

          {modelChoices.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {modelChoices.slice(0, 18).map((m) => (
                <Chip
                  key={m}
                  size="sm"
                  variant="flat"
                  className="cursor-pointer"
                  onClick={() => {
                    setVisionModel(m)
                    pushLog(`已选择：${m}（未应用）`)
                  }}
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button color="primary" onPress={() => void applyToBackend()} isDisabled={!selectedModel || !providerReady}>
          应用配置
        </Button>
        <Button variant="flat" onPress={() => void testCaption()} isDisabled={!providerReady}>
          测试图生文（选 3 张图）
        </Button>
        <Button variant="light" onPress={() => void reload(true)}>
          从后端读取
        </Button>

        <div className="ml-auto text-foreground/40 text-xs">
          {settingsMeta ? `settings.json: ${settingsMeta.path}` : 'settings.json: ...'}
        </div>
      </div>

      <div className="text-foreground/50 text-sm">
        说明：建库时会对每个切片的 3 帧做图生文，并写入索引用于后续匹配（会缓存结果避免重复扣费）。
      </div>

      <LogPanel lines={logs} />
    </GlassPanel>
  )
}
