import { Divider, Input, Modal, ModalBody, ModalContent, Spinner } from '@heroui/react'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { TopView } from '@renderer/components/TopView'
import { searchKnowledgeBase } from '@renderer/services/KnowledgeService'
import { FileMetadata, KnowledgeBase, KnowledgeSearchResult } from '@renderer/types'
import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import SearchItemRenderer from './KnowledgeSearchItem'

interface ShowParams {
  base: KnowledgeBase
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const logger = loggerService.withContext('KnowledgeSearchPopup')

const PopupContainer: React.FC<Props> = ({ base, resolve }) => {
  const [open, setOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Array<KnowledgeSearchResult & { file: FileMetadata | null }>>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const { t } = useTranslation()
  const searchInputRef = useRef<HTMLInputElement>(null)

  const handleSearch = async (value: string) => {
    if (!value.trim()) {
      setResults([])
      setSearchKeyword('')
      return
    }

    setSearchKeyword(value.trim())
    setLoading(true)
    try {
      const searchResults = await searchKnowledgeBase(value, base)
      logger.debug(`KnowledgeSearchPopup Search Results: ${searchResults}`)
      setResults(searchResults)
    } catch (error) {
      logger.error(`Failed to search knowledge base ${base.name}:`, error as Error)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  KnowledgeSearchPopup.hide = onCancel

  useEffect(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [])

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
          onClose()
        }
      }}
      size="2xl"
      hideCloseButton
      classNames={{
        base: 'max-w-[700px]',
        body: 'p-0 max-h-[80vh] overflow-hidden',
        wrapper: 'items-center'
      }}>
      <ModalContent className="rounded-[20px] overflow-hidden pb-3">
        <ModalBody>
          <HStack className="px-3 mt-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--color-background-soft)] mr-0.5">
              <Search size={15} />
            </div>
            <Input
              ref={searchInputRef}
              value={searchKeyword}
              placeholder={t('knowledge.search')}
              isClearable
              autoFocus
              variant="flat"
              size="md"
              classNames={{
                base: 'flex-1',
                inputWrapper: 'bg-transparent shadow-none pl-0',
                input: 'pl-0'
              }}
              onValueChange={setSearchKeyword}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch(searchKeyword)
                }
              }}
            />
          </HStack>
          <Divider className="my-0 mt-1 h-[0.5px]" />

          <div className="px-4 overflow-y-auto max-h-[70vh]">
            {loading ? (
              <div className="flex justify-center items-center h-[200px]">
                <Spinner size="lg" />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {results.map((item, index) => (
                  <SearchItemRenderer key={index} item={item} searchKeyword={searchKeyword} />
                ))}
              </div>
            )}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

const TopViewKey = 'KnowledgeSearchPopup'

export default class KnowledgeSearchPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
