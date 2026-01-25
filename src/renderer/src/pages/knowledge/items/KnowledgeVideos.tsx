import { Button, Tooltip } from '@heroui/react'
import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import { DeleteIcon } from '@renderer/components/Icons'
import VideoPopup from '@renderer/components/Popups/VideoPopup'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import { getProviderName } from '@renderer/services/ProviderService'
import { FileTypes, isKnowledgeVideoItem, KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import dayjs from 'dayjs'
import { Plus } from 'lucide-react'
import { FC, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('KnowledgeVideos')

import FileItem from '@renderer/pages/files/FileItem'

import StatusIcon from '../components/StatusIcon'
import {
  ClickableSpan,
  FlexAlignCenter,
  ItemContainer,
  ItemHeader,
  KnowledgeEmptyView,
  RefreshIcon,
  ResponsiveButton,
  StatusIconWrapper
} from '../KnowledgeContent'

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeVideos: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()

  const { base, videoItems, refreshItem, removeItem, getProcessingStatus, addVideo } = useKnowledge(
    selectedBase.id || ''
  )
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const estimateSize = useCallback(() => 75, [])

  useEffect(() => {
    const handleResize = () => {
      setWindowHeight(window.innerHeight)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (!base) {
    return null
  }

  const handleAddVideo = async () => {
    if (disabled) {
      return
    }

    const result = await VideoPopup.show({
      title: t('knowledge.add_video')
    })
    if (!result) {
      return
    }

    if (result && result.videoFile && result.srtFile) {
      addVideo([result.videoFile, result.srtFile])
    }
  }

  return (
    <ItemContainer>
      <ItemHeader>
        <ResponsiveButton
          color="primary"
          startContent={<Plus size={16} />}
          onClick={(e) => {
            e.stopPropagation()
            handleAddVideo()
          }}
          disabled={disabled}>
          {t('knowledge.add_video')}
        </ResponsiveButton>
      </ItemHeader>
      <div className="flex flex-col gap-2.5 p-5 px-4 h-[calc(100vh-135px)]">
        {videoItems.length === 0 ? (
          <KnowledgeEmptyView />
        ) : (
          <DynamicVirtualList
            list={videoItems.reverse()}
            estimateSize={estimateSize}
            overscan={2}
            scrollerStyle={{ height: windowHeight - 270 }}
            autoHideScrollbar>
            {(item) => {
              if (!isKnowledgeVideoItem(item)) {
                return null
              }
              const files = item.content
              const videoFile = files.find((f) => f.type === FileTypes.VIDEO)

              if (!videoFile) {
                logger.warn('Knowledge item is missing video file data.', { itemId: item.id })
                return null
              }

              return (
                <div style={{ height: '75px', paddingTop: '12px' }}>
                  <FileItem
                    key={item.id}
                    fileInfo={{
                      name: (
                        <ClickableSpan onClick={() => window.api.file.openFileWithRelativePath(videoFile)}>
                          <Ellipsis>
                            <Tooltip content={videoFile.origin_name}>{videoFile.origin_name}</Tooltip>
                          </Ellipsis>
                        </ClickableSpan>
                      ),
                      ext: videoFile.ext,
                      extra: `${getDisplayTime(item)} · ${formatFileSize(videoFile.size)}`,
                      actions: (
                        <FlexAlignCenter>
                          {item.uniqueId && (
                            <Button variant="light" isIconOnly startContent={<RefreshIcon />} onClick={() => refreshItem(item)} />
                          )}

                          <StatusIconWrapper>
                            <StatusIcon
                              sourceId={item.id}
                              base={base}
                              getProcessingStatus={getProcessingStatus}
                              type="file"
                            />
                          </StatusIconWrapper>
                          <Button variant="light" isIconOnly onClick={() => removeItem(item)} startContent={<DeleteIcon size={14} className="lucide-custom" />} />
                        </FlexAlignCenter>
                      )
                    }}
                  />
                </div>
              )
            }}
          </DynamicVirtualList>
        )}
      </div>
    </ItemContainer>
  )
}

export default KnowledgeVideos
