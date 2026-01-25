import { Button, Chip, Tab, Tabs, Tooltip } from '@heroui/react'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import { NavbarIcon } from '@renderer/pages/home/ChatNavbar'
import { getProviderName } from '@renderer/services/ProviderService'
import { KnowledgeBase } from '@renderer/types'
import { Book, Folder, Globe, Link, Notebook, Search, Settings, Video } from 'lucide-react'
import { FC, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import EditKnowledgeBasePopup from './components/EditKnowledgeBasePopup'
import KnowledgeSearchPopup from './components/KnowledgeSearchPopup'
import QuotaTag from './components/QuotaTag'
import KnowledgeDirectories from './items/KnowledgeDirectories'
import KnowledgeFiles from './items/KnowledgeFiles'
import KnowledgeNotes from './items/KnowledgeNotes'
import KnowledgeSitemaps from './items/KnowledgeSitemaps'
import KnowledgeUrls from './items/KnowledgeUrls'
import KnowledgeVideos from './items/KnowledgeVideos'

const logger = loggerService.withContext('KnowledgeContent')
interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const KnowledgeContent: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()
  const { base, urlItems, fileItems, directoryItems, noteItems, sitemapItems, videoItems } = useKnowledge(
    selectedBase.id || ''
  )
  const [activeKey, setActiveKey] = useState('files')
  const [quota, setQuota] = useState<number | undefined>(undefined)
  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map())
  const [preprocessMap, setPreprocessMap] = useState<Map<string, boolean>>(new Map())

  const providerName = getProviderName(base?.model)

  useEffect(() => {
    const handlers = [
      window.electron.ipcRenderer.on('file-preprocess-finished', (_, { itemId, quota }) => {
        setPreprocessMap((prev) => new Map(prev).set(itemId, true))
        if (quota) {
          setQuota(quota)
        }
      }),

      window.electron.ipcRenderer.on('file-preprocess-progress', (_, { itemId, progress }) => {
        setProgressMap((prev) => new Map(prev).set(itemId, progress))
      }),

      window.electron.ipcRenderer.on('file-ocr-progress', (_, { itemId, progress }) => {
        setProgressMap((prev) => new Map(prev).set(itemId, progress))
      }),

      window.electron.ipcRenderer.on('directory-processing-percent', (_, { itemId, percent }) => {
        logger.debug('[Progress] Directory:', itemId, percent)
        setProgressMap((prev) => new Map(prev).set(itemId, percent))
      })
    ]

    return () => {
      handlers.forEach((cleanup) => cleanup())
    }
  }, [])
  const knowledgeItems = [
    {
      key: 'files',
      title: t('files.title'),
      icon: activeKey === 'files' ? <Book size={16} color="var(--color-primary)" /> : <Book size={16} />,
      items: fileItems,
      content: <KnowledgeFiles selectedBase={selectedBase} progressMap={progressMap} preprocessMap={preprocessMap} />,
      show: true
    },

    {
      key: 'notes',
      title: t('knowledge.notes'),
      icon: activeKey === 'notes' ? <Notebook size={16} color="var(--color-primary)" /> : <Notebook size={16} />,
      items: noteItems,
      content: <KnowledgeNotes selectedBase={selectedBase} />,
      show: true
    },
    {
      key: 'directories',
      title: t('knowledge.directories'),
      icon: activeKey === 'directories' ? <Folder size={16} color="var(--color-primary)" /> : <Folder size={16} />,
      items: directoryItems,
      content: <KnowledgeDirectories selectedBase={selectedBase} progressMap={progressMap} />,
      show: true
    },
    {
      key: 'urls',
      title: t('knowledge.urls'),
      icon: activeKey === 'urls' ? <Link size={16} color="var(--color-primary)" /> : <Link size={16} />,
      items: urlItems,
      content: <KnowledgeUrls selectedBase={selectedBase} />,
      show: true
    },
    {
      key: 'sitemaps',
      title: t('knowledge.sitemaps'),
      icon: activeKey === 'sitemaps' ? <Globe size={16} color="var(--color-primary)" /> : <Globe size={16} />,
      items: sitemapItems,
      content: <KnowledgeSitemaps selectedBase={selectedBase} />,
      show: true
    },
    // 暂时不显示，后续实现
    {
      key: 'videos',
      title: t('knowledge.videos'),
      icon: activeKey === 'videos' ? <Video size={16} color="var(--color-primary)" /> : <Video size={16} />,
      items: videoItems,
      content: <KnowledgeVideos selectedBase={selectedBase} />,
      show: false
    }
  ]

  if (!base) {
    return null
  }

  const tabItems = knowledgeItems.filter((item) => item.show)

  return (
    <div className="flex w-full flex-col relative">
      <div className="flex items-center justify-between gap-2 px-4 border-b-[0.5px] border-[var(--color-border)]">
        <div className="flex text-[var(--color-text-3)] flex-row items-center gap-2 h-[45px]">
          <Button
            isIconOnly
            variant="light"
            size="sm"
            onPress={() => EditKnowledgeBasePopup.show({ base })}>
            <Settings size={18} color="var(--color-icon)" />
          </Button>
          <div className="flex items-start gap-2.5">
            <div className="flex-shrink-0">
              <label className="text-[var(--color-text-2)]">{t('models.embedding_model')}</label>
            </div>
            <Tooltip content={providerName} placement="bottom">
              <div className="flex flex-wrap gap-1 items-center">
                <Chip size="sm" radius="full" variant="flat">
                  {base.model.name}
                </Chip>
              </div>
            </Tooltip>
            {base.rerankModel && (
              <Chip size="sm" radius="full" variant="flat">
                {base.rerankModel.name}
              </Chip>
            )}
            {base.preprocessProvider && base.preprocessProvider.type === 'preprocess' && (
              <QuotaTag base={base} providerId={base.preprocessProvider?.provider.id} quota={quota} />
            )}
          </div>
        </div>
        <HStack gap={8} alignItems="center">
          <NavbarIcon onClick={() => base && KnowledgeSearchPopup.show({ base: base })}>
            <Search size={18} />
          </NavbarIcon>
        </HStack>
      </div>
      <Tabs
        selectedKey={activeKey}
        onSelectionChange={(key) => setActiveKey(key as string)}
        variant="underlined"
        size="sm"
        classNames={{
          base: 'flex-1',
          tabList: 'px-4 min-h-[48px]',
          tab: 'px-3 py-3 text-[13px]',
          cursor: 'h-0.5',
          tabContent: 'text-[13px]'
        }}>
        {tabItems.map((item) => (
          <Tab
            key={item.key}
            title={
              <div className="flex items-center gap-1.5 px-1">
                {item.icon}
                <span>{item.title}</span>
                <CustomTag size={10} color={item.items.length > 0 ? '#00b96b' : '#cccccc'}>
                  {item.items.length}
                </CustomTag>
              </div>
            }>
            <div className="h-full overflow-hidden">{item.content}</div>
          </Tab>
        ))}
      </Tabs>
    </div>
  )
}

export const KnowledgeEmptyView = () => (
  <div className="flex items-center justify-center m-5">
    <span className="text-[var(--color-text-3)] text-sm">{/* Empty state - no content */}</span>
  </div>
)

export const ItemHeaderLabel = ({ label }: { label: string }) => {
  return (
    <HStack alignItems="center" gap={10}>
      <label className="font-semibold">{label}</label>
    </HStack>
  )
}

export const ItemContainer = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-col gap-2.5 h-full flex-1">{children}</div>
)

export const ItemHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-row items-center justify-between absolute right-4 z-[1000] top-[calc(var(--navbar-height)+12px)] [navbar-position='top']:top-[calc(var(--navbar-height)+10px)]">
    {children}
  </div>
)

export const StatusIconWrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="w-9 h-9 flex items-center justify-center">{children}</div>
)

export const ClickableSpan = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
  <span className="cursor-pointer flex-1 w-0" onClick={onClick}>
    {children}
  </span>
)

export const FlexAlignCenter = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-center">{children}</div>
)

export const ResponsiveButton = Button

// RefreshIcon replacement for child components
export const RefreshIcon = ({ className, ...props }: { className?: string; size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1024 1024"
    width={props.size || 15}
    height={props.size || 15}
    className={className}
    fill="currentColor">
    <path d="M909.1 209.3l-56.4 44.1C775.8 155.1 656.2 92 521.9 92 290 92 102.3 279.5 102 511.5 101.7 743.7 289.8 932 521.9 932c181.3 0 335.8-115.7 395.1-277.7 4.7-12.7-3.9-26.1-16.9-26.1h-62c-8.8 0-16.6 5.6-19.6 14-31.9 88.1-110.1 151.8-206.6 151.8-119.3 0-216-96.8-216-216 0-119.3 96.8-216 216-216 56.7 0 108.1 21.8 146.7 57.4l-87.5 68.6c-6.4 5-9.8 12.7-9.1 20.6.7 7.9 5.8 14.9 13.5 18.4l256.3 116c5 2.3 10.7 2.1 15.5-.4 4.8-2.6 8.2-7.1 9.3-12.4l49.9-234c1.4-6.7-.7-13.6-5.6-18.5-4.9-4.9-11.9-6.9-18.5-5.3z" />
  </svg>
)

export default KnowledgeContent
