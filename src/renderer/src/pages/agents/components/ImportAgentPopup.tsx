import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Radio, RadioGroup } from '@heroui/react'
import { TopView } from '@renderer/components/TopView'
import { useAgents } from '@renderer/hooks/useAgents'
import { useTimer } from '@renderer/hooks/useTimer'
import { getDefaultModel } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { Agent } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  resolve: (value: Agent[] | null) => void
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()
  const { addAgent } = useAgents()
  const [importType, setImportType] = useState<'url' | 'file'>('url')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const { setTimeoutTimer } = useTimer()

  const handleImport = async () => {
    setLoading(true)
    try {
      let agents: Agent[] = []

      if (importType === 'url') {
        if (!url) {
          throw new Error(t('agents.import.error.url_required'))
        }
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(t('agents.import.error.fetch_failed'))
        }
        const data = await response.json()
        agents = Array.isArray(data) ? data : [data]
      } else {
        const result = await window.api.file.open({
          filters: [{ name: t('agents.import.file_filter'), extensions: ['json'] }]
        })

        if (result) {
          agents = JSON.parse(new TextDecoder('utf-8').decode(result.content))
          if (!Array.isArray(agents)) {
            agents = [agents]
          }
        } else {
          setLoading(false)
          return
        }
      }

      // Validate and process agents
      for (const agent of agents) {
        if (!agent.name || !agent.prompt) {
          throw new Error(t('agents.import.error.invalid_format'))
        }

        const newAgent: Agent = {
          id: uuid(),
          name: agent.name,
          emoji: agent.emoji || '🤖',
          group: agent.group || [],
          prompt: agent.prompt,
          description: agent.description || '',
          type: 'agent',
          topics: [],
          messages: [],
          defaultModel: getDefaultModel(),
          regularPhrases: agent.regularPhrases || []
        }
        addAgent(newAgent)
      }

      window.toast.success(t('message.agents.imported'))

      setTimeoutTimer('onFinish', () => EventEmitter.emit(EVENT_NAMES.SHOW_ASSISTANTS), 0)
      setOpen(false)
      resolve(agents)
    } catch (error) {
      window.toast.error(error instanceof Error ? error.message : t('message.agents.import.error'))
    } finally {
      setLoading(false)
    }
  }

  const onCancel = () => {
    setOpen(false)
    resolve(null)
  }

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      isDismissable={false}
      size="lg"
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t('agents.import.title')}</ModalHeader>
            <ModalBody>
              <div className="flex flex-col gap-4">
                <RadioGroup
                  orientation="horizontal"
                  value={importType}
                  onValueChange={(val) => setImportType(val as 'url' | 'file')}
                >
                  <Radio value="url">{t('agents.import.type.url')}</Radio>
                  <Radio value="file">{t('agents.import.type.file')}</Radio>
                </RadioGroup>

                {importType === 'url' && (
                  <Input
                    placeholder={t('agents.import.url_placeholder')}
                    value={url}
                    onValueChange={setUrl}
                    isRequired
                    // errorMessage={!url && t('agents.import.error.url_required')}
                  />
                )}

                {importType === 'file' && (
                  <Button onPress={handleImport} isLoading={loading}>
                    {t('agents.import.select_file')}
                  </Button>
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose}>
                {t('common.cancel')}
              </Button>
              {importType === 'url' && (
                <Button color="primary" onPress={handleImport} isLoading={loading}>
                  {t('agents.import.button')}
                </Button>
              )}
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}

export default class ImportAgentPopup {
  static show() {
    return new Promise<Agent[] | null>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            this.hide()
          }}
        />,
        'ImportAgentPopup'
      )
    })
  }

  static hide() {
    TopView.hide('ImportAgentPopup')
  }
}
