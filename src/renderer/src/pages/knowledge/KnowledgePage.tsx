import { Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { DraggableList } from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import ListItem from '@renderer/components/ListItem'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledge'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import KnowledgeSearchPopup from '@renderer/pages/knowledge/components/KnowledgeSearchPopup'
import { KnowledgeBase } from '@renderer/types'
import { Book, Plus, Settings } from 'lucide-react'
import { FC, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import AddKnowledgeBasePopup from './components/AddKnowledgeBasePopup'
import EditKnowledgeBasePopup from './components/EditKnowledgeBasePopup'
import KnowledgeContent from './KnowledgeContent'

const KnowledgePage: FC = () => {
  const { t } = useTranslation()
  const { bases, renameKnowledgeBase, deleteKnowledgeBase, updateKnowledgeBases } = useKnowledgeBases()
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | undefined>(bases[0])
  const [isDragging, setIsDragging] = useState(false)

  const handleAddKnowledge = useCallback(async () => {
    const newBase = await AddKnowledgeBasePopup.show({ title: t('knowledge.add.title') })
    if (newBase) {
      setSelectedBase(newBase)
    }
  }, [t])

  const handleEditKnowledgeBase = useCallback(async (base: KnowledgeBase) => {
    const newBase = await EditKnowledgeBasePopup.show({ base })
    if (newBase && newBase?.id !== base.id) {
      setSelectedBase(newBase)
    }
  }, [])

  useEffect(() => {
    const hasSelectedBase = bases.find((base) => base.id === selectedBase?.id)
    !hasSelectedBase && setSelectedBase(bases[0])
  }, [bases, selectedBase])

  const getMenuItems = useCallback(
    (base: KnowledgeBase) => {
      return [
        {
          key: 'rename',
          label: t('knowledge.rename'),
          icon: <EditIcon size={14} />,
          onPress: async () => {
            const name = await PromptPopup.show({
              title: t('knowledge.rename'),
              message: '',
              defaultValue: base.name || ''
            })
            if (name && base.name !== name) {
              renameKnowledgeBase(base.id, name)
            }
          }
        },
        {
          key: 'settings',
          label: t('common.settings'),
          icon: <Settings size={14} />,
          onPress: () => handleEditKnowledgeBase(base)
        },
        {
          key: 'divider'
        },
        {
          key: 'delete',
          label: t('common.delete'),
          icon: <DeleteIcon size={14} className="lucide-custom" />,
          className: 'text-danger',
          color: 'danger' as const,
          onPress: () => {
            window.modal.confirm({
              title: t('knowledge.delete_confirm'),
              centered: true,
              onOk: () => {
                setSelectedBase(undefined)
                deleteKnowledgeBase(base.id)
              }
            })
          }
        }
      ]
    },
    [deleteKnowledgeBase, handleEditKnowledgeBase, renameKnowledgeBase, t]
  )

  useShortcut('search_message', () => {
    if (selectedBase) {
      KnowledgeSearchPopup.show({ base: selectedBase }).then()
    }
  })

  return (
    <div className="flex flex-1 flex-col h-[calc(100vh-var(--navbar-height))]">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('knowledge.title')}</NavbarCenter>
      </Navbar>
      <div className="flex flex-1 flex-row min-h-full" id="content-container">
        <div
          className="flex flex-col w-[calc(var(--settings-width)+100px)] border-r-[0.5px] border-[var(--color-border)] p-3 overflow-y-auto"
          style={{
            scrollbarWidth: 'thin'
          }}>
          <DraggableList
            list={bases}
            onUpdate={updateKnowledgeBases}
            style={{ marginBottom: 0, paddingBottom: isDragging ? 50 : 0 }}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={() => setIsDragging(false)}>
            {(base: KnowledgeBase) => {
              const menuItems = getMenuItems(base)
              return (
                <Dropdown key={base.id}>
                  <DropdownTrigger>
                    <div onContextMenu={(e) => e.preventDefault()}>
                      <ListItem
                        active={selectedBase?.id === base.id}
                        icon={<Book size={16} />}
                        title={base.name}
                        onClick={() => setSelectedBase(base)}
                      />
                    </div>
                  </DropdownTrigger>
                  <DropdownMenu aria-label="Knowledge base actions">
                    {menuItems.map((item) =>
                      item.key === 'divider' ? (
                        <DropdownItem key="divider" className="hidden" />
                      ) : (
                        <DropdownItem
                          key={item.key}
                          startContent={item.icon}
                          color={item.color}
                          className={item.className}
                          onPress={item.onPress}>
                          {item.label}
                        </DropdownItem>
                      )
                    )}
                  </DropdownMenu>
                </Dropdown>
              )
            }}
          </DraggableList>
          {!isDragging && (
            <div
              onClick={handleAddKnowledge}
              className="flex flex-row justify-between p-[7px_12px] relative rounded-[var(--list-item-border-radius)] border-[0.5px] border-transparent cursor-pointer hover:bg-[var(--color-background-soft)]">
              <div className="text-[var(--color-text)] text-[13px] flex flex-row items-center gap-2">
                <Plus size={18} />
                {t('button.add')}
              </div>
            </div>
          )}
          <div style={{ minHeight: '10px' }} />
        </div>
        {bases.length === 0 ? (
          <div className="p-[15px_20px] flex w-full flex-col pb-[50px] overflow-y-auto">
            <div className="flex items-center justify-center m-5">
              <span className="text-[var(--color-text-3)] text-sm">{t('knowledge.empty')}</span>
            </div>
          </div>
        ) : selectedBase ? (
          <KnowledgeContent selectedBase={selectedBase} />
        ) : null}
      </div>
    </div>
  )
}

export default KnowledgePage
