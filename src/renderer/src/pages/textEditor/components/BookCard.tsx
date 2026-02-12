import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@heroui/react'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import type { TextBook } from '@shared/types'
import { BookOpen, Clock, FileText, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type CardSize = 'large' | 'medium' | 'small'

type Props = {
  book: TextBook
  size?: CardSize
  isDragging?: boolean
  onTitleChange: (newTitle: string) => void | Promise<void>
  onDelete: () => void
  onRead: () => void
}

const SIZE_STYLES: Record<
  CardSize,
  {
    cardMaxWidth: string
    coverPadding: string
    title: string
    metaText: string
    badge: string
    titleTop: string
    statsTop: string
    actionIcon: number
    statIcon: number
  }
> = {
  large: {
    cardMaxWidth: 'max-w-[280px]',
    coverPadding: 'p-[14px_14px_12px_16px]',
    title: 'text-lg',
    metaText: 'text-xs',
    badge: 'h-5 px-2 text-xs',
    titleTop: 'mt-9',
    statsTop: 'mt-2',
    actionIcon: 16,
    statIcon: 13
  },
  medium: {
    cardMaxWidth: 'max-w-[240px]',
    coverPadding: 'p-[12px_12px_10px_14px]',
    title: 'text-base',
    metaText: 'text-[11px]',
    badge: 'h-5 px-2 text-[11px]',
    titleTop: 'mt-8',
    statsTop: 'mt-1.5',
    actionIcon: 15,
    statIcon: 12
  },
  small: {
    cardMaxWidth: 'max-w-[196px]',
    coverPadding: 'p-[10px_10px_9px_12px]',
    title: 'text-sm',
    metaText: 'text-[10px]',
    badge: 'h-[18px] px-1.5 text-[10px]',
    titleTop: 'mt-7',
    statsTop: 'mt-1',
    actionIcon: 14,
    statIcon: 11
  }
}

export default function BookCard({
  book,
  size = 'medium',
  isDragging = false,
  onTitleChange,
  onDelete,
  onRead
}: Props) {
  const { t, i18n } = useTranslation()
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleteConfirmPending, setIsDeleteConfirmPending] = useState(false)

  const hue = useMemo(() => hashStringToHue(book.id), [book.id])
  const fileSizeLabel = formatBytes(book.fileSize)
  const updatedAtLabel = formatIsoDateTime(book.updatedAt, i18n.language)
  const title = book.title
  const sizeStyle = SIZE_STYLES[size]

  const handleRename = async () => {
    const nextTitle = await PromptPopup.show({
      title: t('textEditor.editTitle', '修改标题'),
      message: '',
      defaultValue: title,
      inputPlaceholder: t('textEditor.titlePlaceholder', '请输入标题'),
      inputProps: { rows: 1 }
    })
    const next = (nextTitle ?? '').trim()
    if (!next) {
      if (nextTitle !== null) {
        window.toast?.error?.(t('textEditor.titleRequired', '标题不能为空'))
      }
      return
    }
    if (next === title) return
    await Promise.resolve(onTitleChange(next))
    window.toast?.success?.(t('common.saved', '已保存'))
  }

  const handleDelete = () => {
    setIsDeleteModalOpen(false)
    setIsDeleteConfirmPending(false)
    onDelete()
  }

  // Handle keyboard delete with confirmation
  const handleKeyboardDelete = useCallback(async () => {
    if (isDeleteConfirmPending) return

    setIsDeleteConfirmPending(true)
    try {
      const confirmed = await new Promise<boolean>((resolve) => {
        window.modal?.confirm({
          title: t('textEditor.deleteConfirmTitle', '删除确认'),
          content: t('textEditor.deleteConfirmMessage', '确定要将此图书移入回收站吗？'),
          centered: true,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })

      if (confirmed) {
        onDelete()
      }
    } finally {
      setIsDeleteConfirmPending(false)
    }
  }, [isDeleteConfirmPending, onDelete, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRead()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        void handleKeyboardDelete()
      }
    },
    [onRead, handleKeyboardDelete]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRead}
      onKeyDown={handleKeyDown}
      style={{ ['--book-hue' as never]: hue }}
      className={`group w-full ${sizeStyle.cardMaxWidth} cursor-pointer overflow-hidden rounded-2xl border border-divider bg-content1 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        isDragging ? 'opacity-60 scale-[1.02] shadow-2xl ring-2 ring-primary' : ''
      }`}>
      {/* Cover Area */}
      <div
        className={`relative aspect-[2/3] ${sizeStyle.coverPadding} flex flex-col gap-2.5 justify-between text-white/92`}
        style={{
          background: `linear-gradient(135deg, hsl(var(--book-hue, 210), 70%, 56%), hsl(calc(var(--book-hue, 210) + 22), 70%, 42%))`
        }}>
        {/* Gradient overlays */}
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-white/[0.18] via-transparent to-black/[0.12]" />
        <div className="absolute top-0 bottom-0 left-0 w-3 pointer-events-none bg-gradient-to-r from-black/[0.28] to-transparent opacity-65" />

        {/* Quick Actions */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-2.5 right-2.5 flex gap-1.5 opacity-0 -translate-y-0.5 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0 hover:opacity-100 hover:translate-y-0">
          <Tooltip content={t('textEditor.clickToRead', '点击阅读')}>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
              aria-label={t('textEditor.clickToRead', '点击阅读')}
              onClick={(e) => {
                e.stopPropagation()
                onRead()
              }}>
              <BookOpen size={sizeStyle.actionIcon} />
            </Button>
          </Tooltip>

          <Tooltip content={t('textEditor.editTitle', '修改标题')}>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
              aria-label={t('textEditor.editTitle', '修改标题')}
              onClick={(e) => {
                e.stopPropagation()
                void handleRename()
              }}>
              <Pencil size={sizeStyle.actionIcon} />
            </Button>
          </Tooltip>

          <Dropdown
            closeOnSelect={false}
            onOpenChange={(open) => {
              if (!open) setIsDeleteModalOpen(false)
            }}>
            <DropdownTrigger>
              <Button
                isIconOnly
                size="sm"
                variant="flat"
                className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
                aria-label="More actions"
                onClick={(e) => e.stopPropagation()}>
                <MoreVertical size={sizeStyle.actionIcon} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label="Book actions">
              {isDeleteModalOpen ? (
                <>
                  <DropdownItem key="confirm-text" className="opacity-70" isReadOnly>
                    {t('textEditor.deleteConfirmMessage', '确定要将此图书移入回收站吗？')}
                  </DropdownItem>
                  <DropdownItem
                    key="confirm-delete"
                    color="danger"
                    className="text-danger"
                    startContent={<Trash2 size={16} />}
                    onPress={handleDelete}>
                    {t('textEditor.delete', '删除')}
                  </DropdownItem>
                  <DropdownItem key="cancel" onPress={() => setIsDeleteModalOpen(false)}>
                    {t('common.cancel', '取消')}
                  </DropdownItem>
                </>
              ) : (
                <DropdownItem
                  key="delete"
                  color="danger"
                  className="text-danger"
                  startContent={<Trash2 size={16} />}
                  onPress={() => setIsDeleteModalOpen(true)}>
                  {t('textEditor.delete', '删除')}
                </DropdownItem>
              )}
            </DropdownMenu>
          </Dropdown>
        </div>

        {/* Badge */}
        <span
          className={`absolute top-2.5 left-3 inline-flex items-center justify-center rounded-full font-semibold tracking-wide text-white/92 bg-black/[0.22] border border-white/[0.14] ${sizeStyle.badge}`}>
          TXT
        </span>

        {/* Title（按诉求移至上方并加粗） */}
        <div className={`relative ${sizeStyle.titleTop}`} onClick={(e) => e.stopPropagation()}>
          <p className={`m-0 text-white font-bold leading-tight line-clamp-2 ${sizeStyle.title}`} title={title}>
            {title}
          </p>
        </div>

        {/* Stats（移除容器，直接贴在书名下方） */}
        <div className={sizeStyle.statsTop}>
          <div
            className={`flex items-center gap-3 overflow-hidden whitespace-nowrap text-white/90 ${sizeStyle.metaText}`}>
            <span className="inline-flex items-center gap-1.5 leading-tight" title={fileSizeLabel}>
              <FileText size={sizeStyle.statIcon} className="flex-none" />
              <span>{fileSizeLabel}</span>
            </span>

            {typeof book.charCount === 'number' && (
              <span
                className="inline-flex items-center gap-1.5 leading-tight"
                title={`${book.charCount.toLocaleString(i18n.language)} ${t('textEditor.chars', '字')}`}>
                <span>{book.charCount.toLocaleString(i18n.language)}</span>
                <span>{t('textEditor.chars', '字')}</span>
              </span>
            )}
          </div>

          <div className={`mt-1.5 flex min-w-0 items-center text-white/80 ${sizeStyle.metaText}`}>
            <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight" title={updatedAtLabel}>
              <Clock size={sizeStyle.statIcon} className="flex-none" />
              <span className="min-w-0 overflow-hidden text-ellipsis">{updatedAtLabel}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

const hashStringToHue = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  const precision = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[index]}`
}

const formatIsoDateTime = (iso: string, locale: string): string => {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return new Intl.DateTimeFormat(locale || 'zh-CN', {
      dateStyle: 'medium'
    }).format(date)
  } catch {
    return iso
  }
}
