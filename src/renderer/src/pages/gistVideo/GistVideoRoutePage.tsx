import { Button, Card, CardBody, Chip, Tab, Tabs } from '@heroui/react'
import { ArrowLeft, PlugZap, Square } from 'lucide-react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ensureEndpoint } from './apiClient'
import ApiSettingsTab from './ApiSettingsTab'
import ProjectLibraryTab from './ProjectLibraryTab'
import RenderTab from './RenderTab'
import type { GistVideoEndpoint } from './types'
import DragBar from '../workflow/components/DragBar'

export default function GistVideoRoutePage() {
  const navigate = useNavigate()
  const [endpoint, setEndpoint] = useState<GistVideoEndpoint | null>(null)
  const [error, setError] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'library' | 'render' | 'settings'>('library')

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

  const statusChip = useMemo(() => {
    if (!endpoint) {
      return (
        <Chip color="danger" variant="flat" startContent={<Square size={14} />}>
          后端未连接
        </Chip>
      )
    }
    return (
      <Chip color="success" variant="flat" startContent={<PlugZap size={14} />}>
        已连接
      </Chip>
    )
  }, [endpoint])

  return (
    <>
      <DragBar />
      <div className="relative flex h-full w-full flex-col bg-background">
        <div
          className="relative z-10 flex items-center justify-between gap-4 border-foreground/10 border-b px-6 py-4"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <div className="flex items-center gap-3">
            <Button
              isIconOnly
              radius="full"
              variant="light"
              onPress={() => navigate(-1)}
              aria-label="返回"
              style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <ArrowLeft size={18} />
            </Button>
            <h1 className="font-semibold text-xl">视频解说</h1>
            <div style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>{statusChip}</div>
          </div>

          <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
            <Button variant="flat" onPress={() => void connect(true)}>
              重新连接
            </Button>
            <Button
              variant="flat"
              color="danger"
              onPress={() => {
                setEndpoint(null)
                void window.api.gistVideo.stopBackend()
              }}
            >
              停止后端
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-6xl space-y-5">
            <div className="text-foreground/50 text-sm">
              {endpoint ? `后端已连接：${endpoint.baseUrl}` : '后端未连接'}
            </div>

            {error ? (
              <Card className="border-danger-200 bg-danger-50">
                <CardBody className="space-y-2 p-4">
                  <div className="font-medium text-danger-700">gist-video 后端启动失败</div>
                  <div className="text-danger-700/80 text-sm">{error}</div>
                  <div className="text-danger-700/70 text-xs">
                    你可以先确认后端可执行文件是否存在、是否被杀软拦截，以及后端端口是否可用；必要时点“重新连接”强制重启。
                  </div>
                </CardBody>
              </Card>
            ) : null}

            <div className="inline-flex rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
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
                <Tab key="settings" title="API 设置" />
              </Tabs>
            </div>

            {activeTab === 'library' ? <ProjectLibraryTab /> : null}
            {activeTab === 'render' ? <RenderTab /> : null}
            {activeTab === 'settings' ? <ApiSettingsTab /> : null}

            {endpoint ? (
              <div className="text-foreground/40 text-xs">
                dataDir: {endpoint.dataDir} · backendRoot: {endpoint.backendRoot} · pid: {endpoint.pid} · port:{' '}
                {endpoint.port}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
