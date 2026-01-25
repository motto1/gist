import { Button, Tooltip } from '@heroui/react'
import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import { DeleteIcon } from '@renderer/components/Icons'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import FileItem from '@renderer/pages/files/FileItem'
import { getProviderName } from '@renderer/services/ProviderService'
import { KnowledgeBase, KnowledgeItem } from '@renderer/types'
import dayjs from 'dayjs'
import { PlusIcon } from 'lucide-react'
import { FC, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

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

const logger = loggerService.withContext('KnowledgeDirectories')

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
  progressMap: Map<string, number>
}

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeDirectories: FC<KnowledgeContentProps> = ({ selectedBase, progressMap }) => {
  const { t } = useTranslation()

  const { base, directoryItems, refreshItem, removeItem, getProcessingStatus, addDirectory } = useKnowledge(
    selectedBase.id || ''
  )

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const reversedItems = useMemo(() => [...directoryItems].reverse(), [directoryItems])
  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddDirectory = async () => {
    if (disabled) {
      return
    }

    const path = await window.api.file.selectFolder()
    logger.info('Selected directory:', path)
    path && addDirectory(path)
  }

  return (
    <ItemContainer>
      <ItemHeader>
        <ResponsiveButton
          color="primary"
          startContent={<PlusIcon size={16} />}
          onClick={(e) => {
            e.stopPropagation()
            handleAddDirectory()
          }}
          disabled={disabled}>
          {t('knowledge.add_directory')}
        </ResponsiveButton>
      </ItemHeader>
      <div className="p-5 px-4 h-[calc(100vh-135px)]">
        {directoryItems.length === 0 && <KnowledgeEmptyView />}
        <DynamicVirtualList
          list={reversedItems}
          estimateSize={estimateSize}
          overscan={2}
          scrollerStyle={{ paddingRight: 2 }}
          itemContainerStyle={{ paddingBottom: 10 }}
          autoHideScrollbar>
          {(item) => (
            <FileItem
              key={item.id}
              fileInfo={{
                name: (
                  <ClickableSpan onClick={() => window.api.file.openPath(item.content as string)}>
                    <Ellipsis>
                      <Tooltip content={item.content as string}>{item.content as string}</Tooltip>
                    </Ellipsis>
                  </ClickableSpan>
                ),
                ext: '.folder',
                extra: getDisplayTime(item),
                actions: (
                  <FlexAlignCenter>
                    {item.uniqueId && <Button variant="light" isIconOnly startContent={<RefreshIcon />} onClick={() => refreshItem(item)} />}
                    <StatusIconWrapper>
                      <StatusIcon
                        sourceId={item.id}
                        base={base}
                        getProcessingStatus={getProcessingStatus}
                        progress={progressMap.get(item.id)}
                        type="directory"
                      />
                    </StatusIconWrapper>
                    <Button
                      variant="light"
                      isIconOnly
                      onClick={() => removeItem(item)}
                      startContent={<DeleteIcon size={14} className="lucide-custom" />}
                    />
                  </FlexAlignCenter>
                )
              }}
            />
          )}
        </DynamicVirtualList>
      </div>
    </ItemContainer>
  )
}

export default KnowledgeDirectories
