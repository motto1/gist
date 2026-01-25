import { loggerService } from '@logger'
import { FileMetadata, KnowledgeSearchResult } from '@renderer/types'
import React, { FC, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactPlayer from 'react-player'

import { CopyButtonContainer, KnowledgeItemMetadata } from './components'
import { useHighlightText } from './hooks'

interface Props {
  item: KnowledgeSearchResult & {
    file: FileMetadata | null
  }
  searchKeyword: string
}

const logger = loggerService.withContext('KnowledgeSearchPopup VideoItem')

const VideoItem: FC<Props> = ({ item, searchKeyword }) => {
  const { t } = useTranslation()
  const playerRef = useRef<HTMLVideoElement | null>(null)

  const { highlightText } = useHighlightText()

  /**
   * 渲染本地视频文件
   */
  const renderLocalVideo = () => {
    if (!item.metadata.video.path) {
      logger.warn('Local video was requested but block.filePath is missing.')
      return <div className="flex items-center justify-center h-full text-default-400 text-sm">{t('knowledge.error.video.local_file_missing')}</div>
    }

    const videoSrc = `file://${item.metadata?.video?.path}`

    const handleReady = () => {
      const startTime = Math.floor(item.metadata?.startTime ?? 0)
      if (playerRef.current) {
        playerRef.current.currentTime = startTime
      }
    }

    return (
      <ReactPlayer
        ref={playerRef}
        style={{
          height: '100%',
          width: '100%'
        }}
        src={videoSrc}
        controls
        onReady={handleReady}
      />
    )
  }

  const renderVideo = () => {
    switch (item.metadata?.type) {
      case 'video':
        return renderLocalVideo()

      default:
        return
    }
  }

  return (
    <>
      <KnowledgeItemMetadata item={item} />
      <CopyButtonContainer textToCopy={item.pageContent} tooltipTitle={t('common.copy')} />
      <p className="select-text mb-0 text-sm">{highlightText(item.pageContent, searchKeyword)}</p>
      <div className="w-full aspect-video h-auto bg-black mt-2 rounded-lg overflow-hidden">
        {renderVideo()}
      </div>
    </>
  )
}

export default React.memo(VideoItem)
