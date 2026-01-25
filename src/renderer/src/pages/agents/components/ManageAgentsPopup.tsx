import { Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/react'
import { DraggableList } from '@renderer/components/DraggableList'
import { TopView } from '@renderer/components/TopView'
import { useAgents } from '@renderer/hooks/useAgents'
import { GripVertical } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const PopupContainer: React.FC = () => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()
  const { agents, updateAgents } = useAgents()

  const onClose = () => {
    setOpen(false)
    setTimeout(() => ManageAgentsPopup.hide(), 200)
  }

  useEffect(() => {
    if (agents.length === 0) {
      setOpen(false)
    }
  }, [agents])

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader>{t('agents.manage.title')}</ModalHeader>
        <ModalBody>
          <div className="py-3 h-[50vh] overflow-y-auto scrollbar-hide">
            {agents.length > 0 ? (
              <DraggableList list={agents} onUpdate={updateAgents}>
                {(item) => (
                  <div className="flex flex-row items-center justify-between p-2 rounded-lg select-none bg-[var(--color-background-soft)] mb-2 hover:bg-[var(--color-background-mute)]">
                    <div className="mr-2 flex items-center gap-2">
                      <span>{item.emoji}</span>
                      <span>{item.name}</span>
                    </div>
                    <div className="flex gap-[15px]">
                      <GripVertical size={16} className="text-[var(--color-icon)] cursor-move" />
                    </div>
                  </div>
                )}
              </DraggableList>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
                <p>{t('common.no_data')}</p>
              </div>
            )}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

export default class ManageAgentsPopup {
  static topviewId = 0
  static hide() {
    TopView.hide('ManageAgentsPopup')
  }
  static show() {
    TopView.show(<PopupContainer />, 'ManageAgentsPopup')
  }
}
