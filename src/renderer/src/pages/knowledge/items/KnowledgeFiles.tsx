import { Button, Tooltip } from '@heroui/react'
import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import { useFiles } from '@renderer/hooks/useFiles'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import FileItem from '@renderer/pages/files/FileItem'
import StatusIcon from '@renderer/pages/knowledge/components/StatusIcon'
import FileManager from '@renderer/services/FileManager'
import { getProviderName } from '@renderer/services/ProviderService'
import { FileMetadata, FileTypes, isKnowledgeFileItem, KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { formatFileSize, uuid } from '@renderer/utils'
import { bookExts, documentExts, textExts, thirdPartyApplicationExts } from '@shared/config/constant'
import dayjs from 'dayjs'
import { FC, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('KnowledgeFiles')

import { DeleteIcon } from '@renderer/components/Icons'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { PlusIcon, Upload as UploadIcon } from 'lucide-react'

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
  progressMap: Map<string, number>
  preprocessMap: Map<string, boolean>
}

const fileTypes = [...bookExts, ...thirdPartyApplicationExts, ...documentExts, ...textExts]

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeFiles: FC<KnowledgeContentProps> = ({ selectedBase, progressMap, preprocessMap }) => {
  const { t } = useTranslation()
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { onSelectFile, selecting } = useFiles({ extensions: fileTypes })

  const { base, fileItems, addFiles, refreshItem, removeItem, getProcessingStatus } = useKnowledge(
    selectedBase.id || ''
  )

  useEffect(() => {
    const handleResize = () => {
      setWindowHeight(window.innerHeight)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddFile = async () => {
    if (disabled || selecting) {
      return
    }
    const selectedFiles = await onSelectFile({ multipleSelections: true })
    processFiles(selectedFiles)
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleDrop(Array.from(e.target.files))
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDropEvent = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (disabled) {
      return
    }

    const files = Array.from(e.dataTransfer.files)
    handleDrop(files)
  }

  const handleDrop = async (files: File[]) => {
    if (disabled) {
      return
    }
    if (files) {
      const _files: FileMetadata[] = files
        .map((file) => {
          const filePath = window.api.file.getPathForFile(file)
          let nameFromPath = filePath
          const lastSlash = filePath.lastIndexOf('/')
          const lastBackslash = filePath.lastIndexOf('\\')
          if (lastSlash !== -1 || lastBackslash !== -1) {
            nameFromPath = filePath.substring(Math.max(lastSlash, lastBackslash) + 1)
          }

          const extFromPath = nameFromPath.includes('.') ? `.${nameFromPath.split('.').pop()}` : ''

          return {
            id: uuid(),
            name: nameFromPath,
            path: filePath,
            size: file.size,
            ext: extFromPath.toLowerCase(),
            count: 1,
            origin_name: file.name,
            type: file.type as FileTypes,
            created_at: new Date(file.lastModified).toISOString(),
            mtime: file.lastModified
          }
        })
        .filter(({ ext }) => fileTypes.includes(ext))
      processFiles(_files)
    }
  }

  const processFiles = async (files: FileMetadata[]) => {
    logger.debug('processFiles', files)
    if (files.length > 0) {
      const uploadedFiles = await FileManager.uploadFiles(files)
      addFiles(uploadedFiles)
    }
  }

  const showPreprocessIcon = (item: KnowledgeItem) => {
    if (base.preprocessProvider && item.isPreprocessed !== false) {
      return true
    }
    if (!base.preprocessProvider && item.isPreprocessed === true) {
      return true
    }
    return false
  }

  return (
    <ItemContainer>
      <ItemHeader>
        <ResponsiveButton
          color="primary"
          startContent={<PlusIcon size={16} />}
          onClick={(e) => {
            e.stopPropagation()
            handleAddFile()
          }}
          disabled={disabled}>
          {t('knowledge.add_file')}
        </ResponsiveButton>
      </ItemHeader>

      <div className="flex flex-col p-5 px-4 gap-2.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={fileTypes.join(',')}
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div
          onClick={(e) => {
            e.stopPropagation()
            if (!disabled) {
              fileInputRef.current?.click()
            }
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDropEvent}
          className={`
            border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
            transition-colors duration-200
            ${isDragging ? 'border-[var(--color-primary)] bg-[var(--color-primary-light)]' : 'border-[var(--color-border)]'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-[var(--color-primary)]'}
          `}>
          <div className="flex flex-col items-center gap-2">
            <UploadIcon size={32} className="text-[var(--color-text-3)]" />
            <p className="text-sm text-[var(--color-text-2)]">{t('knowledge.drag_file')}</p>
            <p className="text-xs text-[var(--color-text-3)]">
              {t('knowledge.file_hint', { file_types: 'TXT, MD, HTML, PDF, DOCX, PPTX, XLSX, EPUB...' })}
            </p>
          </div>
        </div>
        {fileItems.length === 0 ? (
          <KnowledgeEmptyView />
        ) : (
          <DynamicVirtualList
            list={fileItems.reverse()}
            estimateSize={estimateSize}
            overscan={2}
            scrollerStyle={{ height: windowHeight - 270 }}
            autoHideScrollbar>
            {(item) => {
              if (!isKnowledgeFileItem(item)) {
                return null
              }
              const file = item.content
              return (
                <div style={{ height: '75px', paddingTop: '12px' }}>
                  <FileItem
                    key={item.id}
                    fileInfo={{
                      name: (
                        <ClickableSpan onClick={() => window.api.file.openFileWithRelativePath(file)}>
                          <Ellipsis>
                            <Tooltip content={file.origin_name}>{file.origin_name}</Tooltip>
                          </Ellipsis>
                        </ClickableSpan>
                      ),
                      ext: file.ext,
                      extra: `${getDisplayTime(item)} · ${formatFileSize(file.size)}`,
                      actions: (
                        <FlexAlignCenter>
                          {item.uniqueId && (
                            <Button variant="light" isIconOnly startContent={<RefreshIcon />} onClick={() => refreshItem(item)} />
                          )}
                          {showPreprocessIcon(item) && (
                            <StatusIconWrapper>
                              <StatusIcon
                                sourceId={item.id}
                                base={base}
                                getProcessingStatus={getProcessingStatus}
                                type="file"
                                isPreprocessed={preprocessMap.get(item.id) || item.isPreprocessed || false}
                                progress={progressMap.get(item.id)}
                              />
                            </StatusIconWrapper>
                          )}
                          <StatusIconWrapper>
                            <StatusIcon
                              sourceId={item.id}
                              base={base}
                              getProcessingStatus={getProcessingStatus}
                              type="file"
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
                </div>
              )
            }}
          </DynamicVirtualList>
        )}
      </div>
    </ItemContainer>
  )
}

export default KnowledgeFiles
