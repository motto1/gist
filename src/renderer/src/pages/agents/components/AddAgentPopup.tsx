import 'emoji-picker-element'

import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Popover, PopoverContent, PopoverTrigger, Select, SelectItem } from '@heroui/react'
import { loggerService } from '@logger'
import EmojiPicker from '@renderer/components/EmojiPicker'
import { TopView } from '@renderer/components/TopView'
import { AGENT_PROMPT } from '@renderer/config/prompts'
import { useAgents } from '@renderer/hooks/useAgents'
import { useSidebarIconShow } from '@renderer/hooks/useSidebarIcon'
import { fetchGenerate } from '@renderer/services/ApiService'
import { getDefaultModel } from '@renderer/services/AssistantService'
import { estimateTextTokens } from '@renderer/services/TokenService'
import { useAppSelector } from '@renderer/store'
import { Agent, KnowledgeBase } from '@renderer/types'
import { getLeadingEmoji, uuid } from '@renderer/utils'
import { Check, Loader, RotateCcw, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import stringWidth from 'string-width'

interface Props {
  resolve: (data: Agent | null) => void
}

type FormData = {
  id: string
  name: string
  prompt: string
  knowledge_base_ids: string[]
}

const logger = loggerService.withContext('AddAgentPopup')

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const resolvedRef = useRef(false)
  const { t } = useTranslation()
  const { addAgent } = useAgents()
  const [emoji, setEmoji] = useState('')
  const [loading, setLoading] = useState(false)
  const [showUndoButton, setShowUndoButton] = useState(false)
  const [originalPrompt, setOriginalPrompt] = useState('')
  const [tokenCount, setTokenCount] = useState(0)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [formData, setFormData] = useState<FormData>({
    id: '',
    name: '',
    prompt: '',
    knowledge_base_ids: []
  })
  const knowledgeState = useAppSelector((state) => state.knowledge)
  const showKnowledgeIcon = useSidebarIconShow('knowledge')

  useEffect(() => {
    const updateTokenCount = async () => {
      if (formData.prompt) {
        const count = await estimateTextTokens(formData.prompt)
        setTokenCount(count)
      } else {
        setTokenCount(0)
      }
    }
    updateTokenCount()
  }, [formData.prompt])

  const handleSubmit = () => {
    const _emoji = emoji || getLeadingEmoji(formData.name)

    if (formData.name.trim() === '' || formData.prompt.trim() === '') {
      return
    }

    if (resolvedRef.current) return

    const _agent: Agent = {
      id: uuid(),
      name: formData.name,
      knowledge_bases: formData.knowledge_base_ids
        ?.map((id) => knowledgeState.bases.find((t) => t.id === id))
        ?.filter((base): base is KnowledgeBase => base !== undefined),
      emoji: _emoji,
      prompt: formData.prompt,
      defaultModel: getDefaultModel(),
      type: 'agent',
      topics: [],
      messages: []
    }

    addAgent(_agent)
    resolvedRef.current = true
    resolve(_agent)
    setOpen(false)
  }

  const handleCancel = () => {
    if (hasUnsavedChanges) {
      window.modal.confirm({
        title: t('common.confirm'),
        content: t('agents.add.unsaved_changes_warning'),
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        centered: true,
        onOk: () => {
          if (!resolvedRef.current) {
            resolvedRef.current = true
            resolve(null)
          }
          setOpen(false)
        }
      })
    } else {
      if (!resolvedRef.current) {
        resolvedRef.current = true
        resolve(null)
      }
      setOpen(false)
    }
  }

  const handleGenerateButtonClick = async () => {
    const content = formData.prompt
    const promptText = content || formData.name

    if (!promptText) {
      return
    }

    if (content) {
      navigator.clipboard.writeText(content)
    }

    setLoading(true)
    setShowUndoButton(false)

    try {
      const generatedText = await fetchGenerate({
        prompt: AGENT_PROMPT,
        content: promptText
      })
      setFormData({ ...formData, prompt: generatedText })
      setShowUndoButton(true)
      setOriginalPrompt(content)
      setHasUnsavedChanges(true)
    } catch (error) {
      logger.error('Error fetching data:', error as Error)
    }

    setLoading(false)
  }

  const handleUndoButtonClick = async () => {
    setFormData({ ...formData, prompt: originalPrompt })
    setShowUndoButton(false)
  }

  const handleFormChange = (field: keyof FormData, value: string | string[]) => {
    setFormData({ ...formData, [field]: value })
    if (field === 'prompt') {
      setShowUndoButton(false)
    }
    setHasUnsavedChanges(formData.name?.trim() !== '' || formData.prompt?.trim() !== '' || emoji !== '')
  }

  // Compute label width based on the longest label
  const labelWidth = [t('agents.add.name.label'), t('agents.add.prompt.label'), t('agents.add.knowledge_base.label')]
    .map((labelText) => stringWidth(labelText) * 8)
    .reduce((maxWidth, currentWidth) => Math.max(maxWidth, currentWidth), 80)

  return (
    <Modal
      isOpen={open}
      onClose={handleCancel}
      onOpenChange={(isOpen) => !isOpen && handleCancel()}
      size="2xl"
      classNames={{
        base: 'max-w-[600px]'
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex flex-col gap-1">{t('agents.add.title')}</ModalHeader>
            <ModalBody>
              <div className="flex flex-col gap-4 mt-1">
                <div className="flex gap-2 items-center">
                  <div style={{ width: labelWidth, flexShrink: 0 }} className="text-sm">
                    Emoji
                  </div>
                  <Popover placement="bottom-start">
                    <PopoverTrigger>
                      <Button variant="flat" size="sm">
                        {emoji && <span className="text-xl">{emoji}</span>}
                        {!emoji && t('common.select')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-0">
                      <EmojiPicker
                        onEmojiClick={(selectedEmoji) => {
                          setEmoji(selectedEmoji)
                          setHasUnsavedChanges(true)
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="flex gap-2 items-center">
                  <div style={{ width: labelWidth, flexShrink: 0 }} className="text-sm">
                    {t('agents.add.name.label')}
                  </div>
                  <Input
                    placeholder={t('agents.add.name.placeholder')}
                    value={formData.name}
                    onValueChange={(value) => handleFormChange('name', value)}
                    isClearable
                    isRequired
                    classNames={{
                      base: 'flex-1'
                    }}
                  />
                </div>

                <div className="flex gap-2 items-start">
                  <div style={{ width: labelWidth, flexShrink: 0 }} className="text-sm pt-2">
                    {t('agents.add.prompt.label')}
                  </div>
                  <div className="flex-1 relative">
                    <textarea
                      placeholder={t('agents.add.prompt.placeholder')}
                      value={formData.prompt}
                      onChange={(e) => handleFormChange('prompt', e.target.value)}
                      rows={10}
                      className="w-full px-3 py-2 bg-[var(--color-background-soft)] border border-[var(--color-border)] rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] text-sm"
                    />
                    <div className="absolute bottom-2 right-2 bg-[var(--color-background-soft)] px-2 py-1 rounded text-xs text-[var(--color-text-2)] select-none">
                      Tokens: {tokenCount}
                    </div>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="flat"
                      className="absolute top-2 right-2"
                      isDisabled={loading}
                      onPress={handleGenerateButtonClick}
                    >
                      {loading ? <Loader size={16} className="animate-spin" /> : <Zap size={16} />}
                    </Button>
                    {showUndoButton && (
                      <Button
                        isIconOnly
                        size="sm"
                        variant="flat"
                        className="absolute top-2 right-12"
                        onPress={handleUndoButtonClick}
                      >
                        <RotateCcw size={16} />
                      </Button>
                    )}
                  </div>
                </div>

                {showKnowledgeIcon && (
                  <div className="flex gap-2 items-start">
                    <div style={{ width: labelWidth, flexShrink: 0 }} className="text-sm pt-2">
                      {t('agents.add.knowledge_base.label')}
                    </div>
                    <Select
                      selectionMode="multiple"
                      placeholder={t('agents.add.knowledge_base.placeholder')}
                      selectedKeys={new Set(formData.knowledge_base_ids)}
                      onSelectionChange={(keys) => {
                        const selectedKeys = Array.from(keys as Set<string>)
                        handleFormChange('knowledge_base_ids', selectedKeys)
                      }}
                      classNames={{
                        base: 'flex-1'
                      }}
                    >
                      {knowledgeState.bases.map((base) => (
                        <SelectItem key={base.id} textValue={base.name} startContent={<Check size={14} />}>
                          {base.name}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={handleCancel}>
                {t('common.cancel')}
              </Button>
              <Button color="primary" onPress={handleSubmit}>
                {t('agents.add.title')}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}

export default class AddAgentPopup {
  static topviewId = 0
  static hide() {
    TopView.hide('AddAgentPopup')
  }
  static show() {
    return new Promise<Agent | null>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            this.hide()
          }}
        />,
        'AddAgentPopup'
      )
    })
  }
}
