import { Button, Card, CardBody, Chip, Tab, Tabs } from '@heroui/react'
import { useAppSelector } from '@renderer/store'
import { ArrowLeft, PlugZap, Square } from 'lucide-react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import DragBar from '../workflow/components/DragBar'
import { ensureEndpoint, setGistVideoRuntimeConfig } from './apiClient'
import ApiSettingsTab from './ApiSettingsTab'
import ProjectLibraryTab from './ProjectLibraryTab'
import RenderTab from './RenderTab'
import type { GistVideoEndpoint } from './types'

const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

export default function GistVideoRoutePage() {
  const navigate = useNavigate()
  const providers = useAppSelector((s) => s.llm.providers)
  const [endpoint, setEndpoint] = useState<GistVideoEndpoint | null>(null)
  const [error, setError] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'library' | 'render' | 'settings'>('library')

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

  return (
    <>
      <DragBar />
      <div className="relative flex h-full w-full flex-col bg-background">
        <div className="relative z-10 flex items-center gap-4 border-foreground/10 border-b px-6 py-4" style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
          <div className="flex items-center gap-3" style={noDragStyle}>
            <Button isIconOnly radius="full" variant="light" onPress={() => navigate(-1)} aria-label="返回">
              <ArrowLeft size={18} />
            </Button>
            <h1 className="font-semibold text-xl">视频解说</h1>
          </div>

          <Chip
            color={connected ? 'success' : 'danger'}
            variant="flat"
            startContent={connected ? <PlugZap size={14} /> : <Square size={14} />}
            className="h-auto"
            style={noDragStyle}
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
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-6xl space-y-6">
            {error ? (
              <Card className="border-danger-200 bg-danger-50">
                <CardBody className="space-y-2 p-4">
                  <div className="font-medium text-danger-700">gist-video 后端启动失败</div>
                  <div className="text-danger-700/80 text-sm">{error}</div>
                </CardBody>
              </Card>
            ) : null}

            <div className="flex justify-center">
              <div className="rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
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
                  <Tab key="library" title="1. 素材库" />
                  <Tab key="settings" title="2. 图生文设置" />
                  <Tab key="render" title="3. 一键成片" />
                </Tabs>
              </div>
            </div>

            {activeTab === 'library' ? <ProjectLibraryTab /> : null}
            {activeTab === 'settings' ? <ApiSettingsTab /> : null}
            {activeTab === 'render' ? <RenderTab /> : null}

            {endpoint ? (
              <div className="text-center text-foreground/40 text-xs">
                dataDir: {endpoint.dataDir} · backendRoot: {endpoint.backendRoot} · pid: {endpoint.pid} · port: {endpoint.port}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
