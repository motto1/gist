import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useAgents } from '@renderer/hooks/useAgents'
import AssistantSettingsPopup from '@renderer/pages/settings/AssistantSettings'
import { createAssistantFromAgent } from '@renderer/services/AssistantService'
import type { Agent } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import { t } from 'i18next'
import { ArrowDownAZ, Ellipsis, PlusIcon, SquareArrowOutUpRight } from 'lucide-react'
import { type FC, memo, useCallback, useEffect, useRef, useState } from 'react'

import ManageAgentsPopup from './ManageAgentsPopup'

interface Props {
  agent: Agent
  activegroup?: string
  onClick: () => void
  getLocalizedGroupName: (group: string) => string
}

const AgentCard: FC<Props> = ({ agent, onClick, activegroup, getLocalizedGroupName }) => {
  const { removeAgent } = useAgents()
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const handleDelete = useCallback(
    (agent: Agent) => {
      window.modal.confirm({
        centered: true,
        content: t('agents.delete.popup.content'),
        onOk: () => removeAgent(agent.id)
      })
    },
    [removeAgent]
  )

  const exportAgent = useCallback(async () => {
    const result = [
      {
        name: agent.name,
        emoji: agent.emoji,
        group: agent.group,
        prompt: agent.prompt,
        description: agent.description,
        regularPhrases: agent.regularPhrases,
        type: 'agent'
      }
    ]

    const resultStr = JSON.stringify(result, null, 2)

    await window.api.file.save(`${agent.name}.json`, new TextEncoder().encode(resultStr), {
      filters: [{ name: t('agents.import.file_filter'), extensions: ['json'] }]
    })
  }, [agent])

  const menuItems = [
    {
      key: 'edit',
      label: t('agents.edit.title'),
      startContent: <EditIcon size={14} />,
      onPress: () => {
        AssistantSettingsPopup.show({ assistant: agent })
      }
    },
    {
      key: 'create',
      label: t('agents.add.button'),
      startContent: <PlusIcon size={14} />,
      onPress: () => {
        createAssistantFromAgent(agent)
      }
    },
    {
      key: 'sort',
      label: t('agents.sorting.title'),
      startContent: <ArrowDownAZ size={14} />,
      onPress: () => {
        ManageAgentsPopup.show()
      }
    },
    {
      key: 'export',
      label: t('agents.export.agent'),
      startContent: <SquareArrowOutUpRight size={14} />,
      onPress: () => {
        exportAgent()
      }
    },
    {
      key: 'delete',
      label: t('common.delete'),
      startContent: <DeleteIcon size={14} className="lucide-custom" />,
      color: 'danger' as const,
      onPress: () => {
        handleDelete(agent)
      }
    }
  ]

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )

    if (cardRef.current) {
      observer.observe(cardRef.current)
    }

    return () => {
      observer.disconnect()
    }
  }, [])

  const emoji = agent.emoji || getLeadingEmoji(agent.name)
  const prompt = (agent.description || agent.prompt).substring(0, 200).replace(/\\n/g, '')

  const content = (
    <div
      onClick={onClick}
      ref={cardRef}
      className="rounded-[var(--list-item-border-radius)] cursor-pointer border-[0.5px] border-[var(--color-border)] p-4 overflow-hidden transition-all duration-200 shadow-[0_5px_7px_-3px_var(--color-border-soft),0_2px_3px_-4px_var(--color-border-soft)] hover:shadow-[0_10px_15px_-3px_var(--color-border-soft),0_4px_6px_-4px_var(--color-border-soft)] hover:-translate-y-0.5 group"
    >
      {isVisible && (
        <div className="h-full flex flex-col relative animate-[fadeIn_0.2s_ease]">
          <div className="h-full absolute top-0 -right-[50px] text-[200px] flex items-center justify-center pointer-events-none opacity-10 blur-[20px] rounded-[99px] overflow-hidden">
            {emoji}
          </div>
          <div className="flex items-start gap-2 justify-start overflow-hidden">
            <div className="flex-1 flex flex-col gap-[7px]">
              <div className="text-base leading-[1.2] font-semibold overflow-hidden line-clamp-1 break-all">
                {agent.name}
              </div>
              <div className="flex flex-row gap-[5px] flex-wrap">
                {activegroup === '我的' && (
                  <CustomTag color="#A0A0A0" size={11}>
                    {getLocalizedGroupName('我的')}
                  </CustomTag>
                )}
                {!!agent.group?.length &&
                  agent.group.map((group) => (
                    <CustomTag key={group} color="#A0A0A0" size={11}>
                      {getLocalizedGroupName(group)}
                    </CustomTag>
                  ))}
              </div>
            </div>
            {activegroup === '我的' ? (
              <div className="w-[45px] h-[45px] relative flex items-start justify-end">
                <div className="w-[45px] h-[45px] rounded-[var(--list-item-border-radius)] text-[26px] leading-none flex-shrink-0 opacity-100 transition-opacity duration-200 bg-[var(--color-background-soft)] flex items-center justify-center group-hover:opacity-0">
                  {emoji}
                </div>
                <Dropdown placement="bottom-end">
                  <DropdownTrigger>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="flat"
                      className="absolute opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Ellipsis size={14} className="text-[var(--color-text-3)]" />
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu aria-label="Agent actions" items={menuItems}>
                    {(item) => (
                      <DropdownItem
                        key={item.key}
                        color={item.color}
                        startContent={item.startContent}
                        onPress={item.onPress}
                      >
                        {item.label}
                      </DropdownItem>
                    )}
                  </DropdownMenu>
                </Dropdown>
              </div>
            ) : (
              emoji && (
                <div className="w-[45px] h-[45px] rounded-[var(--list-item-border-radius)] text-[26px] leading-none flex-shrink-0 opacity-100 transition-opacity duration-200 bg-[var(--color-background-soft)] flex items-center justify-center">
                  {emoji}
                </div>
              )
            )}
          </div>
          <div className="flex-1 flex flex-col mt-4 bg-[var(--color-background-soft)] p-2 rounded-[10px]">
            <div className="text-xs line-clamp-3 leading-[1.4] overflow-hidden text-[var(--color-text-2)]">
              {prompt}
            </div>
          </div>
        </div>
      )}
    </div>
  )

  if (activegroup === '我的') {
    return (
      <Dropdown placement="bottom-start">
        <DropdownTrigger>
          <div className="contents">{content}</div>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="Agent context menu"
          items={menuItems}
          onAction={(key) => {
            const item = menuItems.find((i) => i.key === key)
            item?.onPress()
          }}
        >
          {(item) => (
            <DropdownItem
              key={item.key}
              color={item.color}
              startContent={item.startContent}
            >
              {item.label}
            </DropdownItem>
          )}
        </DropdownMenu>
      </Dropdown>
    )
  }

  return content
}

export default memo(AgentCard)
