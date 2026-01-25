import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { HStack } from '@renderer/components/Layout'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface PanelConfig {
  key: string
  label: string
  panel: React.ReactNode
}

interface KnowledgeBaseFormModalProps {
  panels: PanelConfig[]
  open: boolean
  title?: string
  okText?: string
  onOk?: () => void
  onCancel?: () => void
  afterClose?: () => void
}

const KnowledgeBaseFormModal: React.FC<KnowledgeBaseFormModalProps> = ({
  panels,
  open,
  title,
  okText,
  onOk,
  onCancel,
  afterClose
}) => {
  const { t } = useTranslation()
  const [selectedMenu, setSelectedMenu] = useState(panels[0]?.key)

  const activePanel = panels.find((p) => p.key === selectedMenu)?.panel

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel?.()
          afterClose?.()
        }
      }}
      size="3xl"
      classNames={{
        base: 'max-w-[min(900px,65vw)]',
        body: 'p-0',
        header: 'border-b-[0.5px] border-[var(--color-border)]',
        footer: 'border-t-[0.5px] border-[var(--color-border)]'
      }}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span className="text-sm">{title}</span>
        </ModalHeader>
        <ModalBody>
          <HStack height="550px" className="overflow-hidden">
            <div className="flex h-full border-r-[0.5px] border-[var(--color-border)]">
              <div className="w-[200px] p-1.5 mt-0.5">
                {panels.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setSelectedMenu(key)}
                    className={`
                      w-full h-9 px-3 mb-1.5 rounded-md flex items-center
                      text-sm transition-colors
                      ${
                        selectedMenu === key
                          ? 'bg-[var(--color-background-soft)] border-[0.5px] border-[var(--color-border)] text-[var(--color-text-1)] font-medium'
                          : 'text-[var(--color-text-2)] hover:bg-[var(--color-background-soft)] border-[0.5px] border-transparent'
                      }
                    `}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 p-4 overflow-y-auto">{activePanel}</div>
          </HStack>
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="flat" onPress={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" color="primary" onPress={onOk}>
            {okText || t('common.ok')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default KnowledgeBaseFormModal
