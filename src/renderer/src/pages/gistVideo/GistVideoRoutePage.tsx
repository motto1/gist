import { Button, Chip, Tab, Tabs } from '@heroui/react'
import { PlugZap, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAppSelector } from '@renderer/store'

import { ensureEndpoint, setGistVideoRuntimeConfig } from './apiClient'
import ApiSettingsTab from './ApiSettingsTab'
import ProjectLibraryTab from './ProjectLibraryTab'
import RenderTab from './RenderTab'
import type { GistVideoEndpoint } from './types'
import DragBar from '../workflow/components/DragBar'
import { GlassPanel, WorkflowAppHeader, WorkflowShell } from '../workflow/components'

export default function GistVideoRoutePage() {
  const navigate = useNavigate()
  const providers = useAppSelector((s) => s.llm.providers)
  const [endpoint, setEndpoint] = useState<GistVideoEndpoint | null>(null)
  const [error, setError] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'library' | 'render' | 'settings'>('library')

  // Best-effort: derive gist-video runtime credentials from the last selected vision model.
  // This avoids asking users to configure API twice.
  const derivedRuntimeConfig = useMemo(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem('gist-video.visionModelSelector.last.v1')
      if (!raw) return null
      const parsed = JSON.parse(raw) as unknown
      const providerId = (parsed as any)?.provider
      if (typeof providerId !== 'string' || !providerId.trim()) return null
      const provider = providers.find((p) => p.id === providerId) || null
      if (!provider?.apiHost?.trim() || !provider?.apiKey?.trim()) return null
      return { visionApiBase: provider.apiHost, visionApiKey: provider.apiKey }
    } catch {
      return null
    }
  }, [providers])

  useEffect(() => {
    setGistVideoRuntimeConfig(derivedRuntimeConfig)
  }, [derivedRuntimeConfig])

  const connect = async (force: boolean = false) => {
    setError('')
    try {
      const ep = await ensureEndpoint(force)
      setEndpoint(ep)
    } catch (e) {
      setEndpoint(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void connect(false)
  }, [])

  const connected = !!endpoint

  const connectionChip = (
    <Chip
      color={connected ? 'success' : 'danger'}
      variant="flat"
      startContent={connected ? <PlugZap size={14} /> : <Square size={14} />}
      className="h-auto"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{connected ? '已连接' : '后端未连接'}</span>
        <span className="h-5 w-px bg-foreground/15" />
        <Button size="sm" variant="light" className="h-7 min-w-0 px-2" onPress={() => void connect(true)}>
          重新连接
        </Button>
        <Button
          size="sm"
          variant="light"
          color="danger"
          className="h-7 min-w-0 px-2"
          onPress={() => {
            setEndpoint(null)
            void window.api.gistVideo.stopBackend()
          }}
        >
          停止后端
        </Button>
      </div>
    </Chip>
  )

  return (
    <>
      <DragBar />
      <WorkflowShell
        maxWidthClassName="max-w-6xl"
        contentClassName="space-y-5"
        header={
          <WorkflowAppHeader title="视频解说" onBack={() => navigate(-1)} meta={connectionChip} />
        }
      >
        <div className="text-foreground/50 text-sm">{endpoint ? `后端已连接：${endpoint.baseUrl}` : '后端未连接'}</div>

        {error ? (
          <GlassPanel
            radiusClassName="rounded-2xl"
            paddingClassName="p-4"
            className="space-y-2 border-danger-200 bg-danger-50"
          >
            <div className="font-medium text-danger-700">gist-video 后端启动失败</div>
            <div className="text-danger-700/80 text-sm">{error}</div>
            <div className="text-danger-700/70 text-xs">
              你可以先确认后端可执行文件是否存在、是否被杀软拦截，以及后端端口是否可用；必要时点“重新连接”强制重启。
            </div>
          </GlassPanel>
        ) : null}

        <GlassPanel className="inline-flex" radiusClassName="rounded-2xl" paddingClassName="p-1.5">
          <Tabs
            size="lg"
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as 'library' | 'render' | 'settings')}
            variant="light"
            classNames={{
              tabList: 'gap-2',
              cursor: 'bg-background shadow-sm',
              tab: 'h-9 px-6',
              tabContent: 'group-data-[selected=true]:text-primary font-medium'
            }}
          >
            <Tab key="library" title="素材库" />
            <Tab key="render" title="一键成片" />
            <Tab key="settings" title="图生文设置" />
          </Tabs>
        </GlassPanel>

        {activeTab === 'library' ? <ProjectLibraryTab /> : null}
        {activeTab === 'render' ? <RenderTab /> : null}
        {activeTab === 'settings' ? <ApiSettingsTab /> : null}

        {endpoint ? (
          <div className="text-foreground/40 text-xs">
            dataDir: {endpoint.dataDir} · backendRoot: {endpoint.backendRoot} · pid: {endpoint.pid} · port: {endpoint.port}
          </div>
        ) : null}
      </WorkflowShell>
    </>
  )
}
