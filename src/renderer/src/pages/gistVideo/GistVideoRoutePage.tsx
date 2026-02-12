import { Button, Card, CardBody, Chip, Tab, Tabs } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { useAppSelector } from '@renderer/store'
import { PlugZap, Square, Video } from 'lucide-react'
import { CSSProperties, useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

import { ensureEndpoint, setGistVideoRuntimeConfig } from './apiClient'
import ApiSettingsTab from './ApiSettingsTab'
import ProjectLibraryTab from './ProjectLibraryTab'
import RenderTab from './RenderTab'
import type { GistVideoEndpoint } from './types'

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

export default function GistVideoRoutePage() {
  const { isTopNavbar } = useNavbarPosition()
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

  const headerContent = (
    <HeaderBar style={dragStyle}>
      <LeftGroup>
        <TitleGroup>
          <TitleIcon>
            <Video size={18} className="icon" />
          </TitleIcon>
          <PageTitle>视频解说</PageTitle>
        </TitleGroup>

        <BackendActions style={noDragStyle}>
          <Chip
            color={connected ? 'success' : 'danger'}
            variant="flat"
            startContent={connected ? <PlugZap size={14} /> : <Square size={14} />}
            className="h-auto">
            {connected ? '已连接' : '后端未连接'}
          </Chip>
          <Button size="sm" variant="light" className="h-8 px-3" onPress={() => void connect(true)}>
            重新连接
          </Button>
          <Button
            size="sm"
            variant="light"
            color="danger"
            className="h-8 px-3"
            onPress={() => {
              setEndpoint(null)
              void window.api.gistVideo.stopBackend()
            }}>
            停止后端
          </Button>
        </BackendActions>
      </LeftGroup>
    </HeaderBar>
  )

  return (
    <Container id="gist-video-page">
      {isTopNavbar ? (
        <TopNavbarHeader>{headerContent}</TopNavbarHeader>
      ) : (
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none', padding: 0 }}>{headerContent}</NavbarCenter>
        </Navbar>
      )}

      <ContentContainer id="content-container">
        <MainScrollArea>
          <MainInner>
            {error ? (
              <Card className="border-danger-200 bg-danger-50">
                <CardBody className="space-y-2 p-4">
                  <div className="font-medium text-danger-700">gist-video 后端启动失败</div>
                  <div className="text-danger-700/80 text-sm">{error}</div>
                </CardBody>
              </Card>
            ) : null}

            <TabsContainer>
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
                }}>
                <Tab key="library" title="1. 素材库" />
                <Tab key="settings" title="2. 图生文设置" />
                <Tab key="render" title="3. 一键成片" />
              </Tabs>
            </TabsContainer>

            {activeTab === 'library' ? <ProjectLibraryTab /> : null}
            {activeTab === 'settings' ? <ApiSettingsTab /> : null}
            {activeTab === 'render' ? <RenderTab /> : null}

            {endpoint ? (
              <MetaLine>
                dataDir: {endpoint.dataDir} · backendRoot: {endpoint.backendRoot} · pid: {endpoint.pid} · port:{' '}
                {endpoint.port}
              </MetaLine>
            ) : null}
          </MainInner>
        </MainScrollArea>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
`

const HeaderBar = styled.div`
  width: 100%;
  height: var(--navbar-height);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  -webkit-app-region: drag;
`

const LeftGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  flex-wrap: wrap;
`

const TitleGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`

const TitleIcon = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-icon);
`

const PageTitle = styled.h1`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-1);
`

const BackendActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  -webkit-app-region: no-drag;
`

const TopNavbarHeader = styled.div`
  width: 100%;
  height: var(--navbar-height);
  border-bottom: 0.5px solid var(--color-border);
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  height: calc(100vh - var(--navbar-height));
  padding: 12px 16px;
  overflow: hidden;

  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height) - 6px);
  }
`

const MainScrollArea = styled.div`
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-app-region: no-drag;
`

const MainInner = styled.div`
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const TabsContainer = styled.div`
  display: flex;
  justify-content: center;
  width: 100%;
  padding: 6px;
  border-radius: 16px;
  border: 0.5px solid var(--color-border);
  background: var(--color-background-soft);
`

const MetaLine = styled.div`
  text-align: center;
  font-size: 12px;
  color: var(--color-text-3);
`
