import { Input } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { HStack } from '@renderer/components/Layout'
import ListItem from '@renderer/components/ListItem'
import Scrollbar from '@renderer/components/Scrollbar'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useAgents } from '@renderer/hooks/useAgents'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { createAssistantFromAgent } from '@renderer/services/AssistantService'
import { Agent } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { omit } from 'lodash'
import { Import, Plus, Search } from 'lucide-react'
import { FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { groupByCategories, useSystemAgents } from '.'
import { groupTranslations } from './agentGroupTranslations'
import AddAgentPopup from './components/AddAgentPopup'
import AgentCard from './components/AgentCard'
import { AgentGroupIcon } from './components/AgentGroupIcon'
import ImportAgentPopup from './components/ImportAgentPopup'

const AgentsPage: FC = () => {
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [activeGroup, setActiveGroup] = useState('我的')
  const [agentGroups, setAgentGroups] = useState<Record<string, Agent[]>>({})
  const [isSearchExpanded, setIsSearchExpanded] = useState(false)
  const systemAgents = useSystemAgents()
  const { agents: userAgents } = useAgents()
  const { isTopNavbar } = useNavbarPosition()

  useEffect(() => {
    const systemAgentsGroupList = groupByCategories(systemAgents)
    const agentsGroupList = {
      我的: userAgents,
      精选: [],
      ...systemAgentsGroupList
    } as Record<string, Agent[]>
    setAgentGroups(agentsGroupList)
  }, [systemAgents, userAgents])

  const filteredAgents = useMemo(() => {
    // 搜索框为空直接返回「我的」分组下的 agent
    if (!search.trim()) {
      return agentGroups[activeGroup] || []
    }
    const uniqueAgents = new Map<string, Agent>()
    Object.entries(agentGroups).forEach(([, agents]) => {
      agents.forEach((agent) => {
        if (
          agent.name.toLowerCase().includes(search.toLowerCase()) ||
          agent.description?.toLowerCase().includes(search.toLowerCase())
        ) {
          uniqueAgents.set(agent.id, agent)
        }
      })
    })
    return Array.from(uniqueAgents.values())
  }, [agentGroups, activeGroup, search])

  const { t, i18n } = useTranslation()

  const onAddAgentConfirm = useCallback(
    (agent: Agent) => {
      window.modal.confirm({
        title: agent.name,
        content: (
          <div className="flex flex-col gap-4 w-full">
            {agent.description && (
              <div className="text-[var(--color-text-2)] text-xs">{agent.description}</div>
            )}

            {agent.prompt && (
              <div className="markdown max-h-[60vh] overflow-y-scroll bg-[var(--color-background-soft)] p-2 rounded-[10px]">
                <ReactMarkdown>{agent.prompt}</ReactMarkdown>
              </div>
            )}
          </div>
        ),
        width: 600,
        icon: null,
        closable: true,
        maskClosable: true,
        centered: true,
        okButtonProps: { type: 'primary' },
        okText: t('agents.add.button'),
        onOk: () => createAssistantFromAgent(agent)
      })
    },
    [t]
  )

  const getAgentFromSystemAgent = useCallback((agent: (typeof systemAgents)[number]) => {
    return {
      ...omit(agent, 'group'),
      name: agent.name,
      id: uuid(),
      topics: [],
      type: 'agent'
    }
  }, [])

  const getLocalizedGroupName = useCallback(
    (group: string) => {
      const currentLang = i18n.language
      return groupTranslations[group]?.[currentLang] || group
    },
    [i18n.language]
  )

  const handleSearch = () => {
    if (searchInput.trim() === '') {
      setSearch('')
      setActiveGroup('我的')
    } else {
      setActiveGroup('')
      setSearch(searchInput)
    }
  }

  const handleSearchClear = () => {
    setSearch('')
    setSearchInput('')
    setActiveGroup('我的')
    setIsSearchExpanded(false)
  }

  const handleSearchIconClick = () => {
    if (!isSearchExpanded) {
      setIsSearchExpanded(true)
    } else {
      handleSearch()
    }
  }

  const handleSearchInputChange = (value: string) => {
    setSearchInput(value)
    // 如果输入内容为空，折叠搜索框
    if (value.trim() === '') {
      setIsSearchExpanded(false)
      setSearch('')
      setActiveGroup('我的')
    }
  }

  const handleSearchInputBlur = () => {
    // 如果输入内容为空，失焦时折叠搜索框
    if (searchInput.trim() === '') {
      setIsSearchExpanded(false)
    }
  }

  const handleGroupClick = (group: string) => () => {
    setSearch('')
    setSearchInput('')
    setActiveGroup(group)
  }

  const handleAddAgent = () => {
    AddAgentPopup.show().then(() => {
      handleSearchClear()
    })
  }

  const handleImportAgent = async () => {
    try {
      await ImportAgentPopup.show()
    } catch (error) {
      window.toast.error(error instanceof Error ? error.message : t('message.agents.import.error'))
    }
  }

  return (
    <div className="flex flex-1 flex-col h-full">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none', justifyContent: 'space-between' }}>
          {t('agents.title')}
          <Input
            placeholder={t('common.search')}
            className="nodrag"
            classNames={{
              base: 'w-[30%] h-7',
              inputWrapper: 'h-7 min-h-7 rounded-[15px] pl-3'
            }}
            size="sm"
            isClearable
            onClear={handleSearchClear}
            endContent={<Search size={14} className="text-[var(--color-icon)] cursor-pointer" onClick={handleSearch} />}
            value={searchInput}
            maxLength={50}
            onValueChange={handleSearchInputChange}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            onBlur={handleSearchInputBlur}
          />
          <div style={{ width: 80 }} />
        </NavbarCenter>
      </Navbar>

      <div className="flex flex-1" id="content-container">
        <Scrollbar className="min-w-[160px] h-[calc(100vh-var(--navbar-height))] flex flex-col gap-2 py-3 border-r-[0.5px] border-[var(--color-border)] rounded-tl-[inherit] rounded-bl-[inherit] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {Object.entries(agentGroups).map(([group]) => (
            <ListItem
              active={activeGroup === group && !search.trim()}
              key={group}
              title={
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <AgentGroupIcon groupName={group} />
                    {getLocalizedGroupName(group)}
                  </div>
                  {
                    <HStack alignItems="center" justifyContent="center" style={{ minWidth: 40 }}>
                      <CustomTag color="#A0A0A0" size={8}>
                        {agentGroups[group].length}
                      </CustomTag>
                    </HStack>
                  }
                </div>
              }
              style={{ margin: '0 8px', paddingLeft: 16, paddingRight: 16 }}
              onClick={handleGroupClick(group)}></ListItem>
          ))}
        </Scrollbar>

        <div className="h-[calc(100vh-var(--navbar-height))] flex-1 flex flex-col">
          <div className="flex items-center justify-between py-3 px-4">
            <div className="text-base leading-[18px] font-medium text-[var(--color-text-1)] flex items-center gap-2">
              {search.trim() ? (
                <>
                  <AgentGroupIcon groupName="搜索" size={24} />
                  {search.trim()}{' '}
                </>
              ) : (
                <>
                  <AgentGroupIcon groupName={activeGroup} size={24} />
                  {getLocalizedGroupName(activeGroup)}
                </>
              )}

              {
                <CustomTag color="#A0A0A0" size={10}>
                  {filteredAgents.length}
                </CustomTag>
              }
            </div>
            <div className="flex gap-2">
              {isSearchExpanded ? (
                <Input
                  placeholder={t('common.search')}
                  className="nodrag"
                  classNames={{
                    base: 'w-[300px] h-7',
                    inputWrapper: 'h-7 min-h-7 rounded-[15px] pl-3'
                  }}
                  size="sm"
                  isClearable
                  onClear={handleSearchClear}
                  endContent={<Search size={14} className="text-[var(--color-icon)] cursor-pointer" onClick={handleSearchIconClick} />}
                  value={searchInput}
                  maxLength={50}
                  onValueChange={handleSearchInputChange}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  onBlur={handleSearchInputBlur}
                  autoFocus
                />
              ) : (
                isTopNavbar && (
                  <button
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-transparent hover:bg-[var(--color-background-mute)] rounded-md transition-colors cursor-pointer border-none text-[var(--color-text)]"
                    onClick={handleSearchIconClick}>
                    <Search size={18} className="text-[var(--color-icon)]" />
                    {t('common.search')}
                  </button>
                )
              )}
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-transparent hover:bg-[var(--color-background-mute)] rounded-md transition-colors cursor-pointer border-none text-[var(--color-text)]"
                onClick={handleImportAgent}>
                <Import size={18} className="text-[var(--color-icon)]" />
                {t('agents.import.title')}
              </button>
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-transparent hover:bg-[var(--color-background-mute)] rounded-md transition-colors cursor-pointer border-none text-[var(--color-text)]"
                onClick={handleAddAgent}>
                <Plus size={18} className="text-[var(--color-icon)]" />
                {t('agents.add.title')}
              </button>
            </div>
          </div>

          {filteredAgents.length > 0 ? (
            <Scrollbar className="flex-1 p-[8px_16px_16px] grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] auto-rows-[160px] gap-4">
              {filteredAgents.map((agent, index) => (
                <AgentCard
                  key={agent.id || index}
                  onClick={() => onAddAgentConfirm(getAgentFromSystemAgent(agent))}
                  agent={agent}
                  activegroup={activeGroup}
                  getLocalizedGroupName={getLocalizedGroupName}
                />
              ))}
            </Scrollbar>
          ) : (
            <div className="h-full flex flex-1 justify-center items-center text-base text-[var(--color-text-secondary)]">
              <div className="flex flex-col items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-[var(--color-fill-2)] flex items-center justify-center">
                  <Search size={32} className="text-[var(--color-text-3)]" />
                </div>
                <p className="text-[var(--color-text-3)] m-0">{t('agents.search.no_results')}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AgentsPage
