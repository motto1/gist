import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from '@heroui/react'
import { ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../TopView'

interface TextAreaProps {
  rows?: number
  allowClear?: boolean
  onPressEnter?: () => void
  [key: string]: any
}

interface PromptPopupShowParams {
  title: string
  message: string
  defaultValue?: string
  inputPlaceholder?: string
  inputProps?: TextAreaProps
  extraNode?: ReactNode
}

interface Props extends PromptPopupShowParams {
  resolve: (value: any) => void
}

const PromptPopupContainer: React.FC<Props> = ({
  title,
  message,
  defaultValue = '',
  inputPlaceholder = '',
  inputProps = {},
  extraNode = null,
  resolve
}) => {
  const { t } = useTranslation()
  const [value, setValue] = useState(defaultValue)
  const [open, setOpen] = useState(true)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)

  const onOk = () => {
    setOpen(false)
    resolve(value)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onAfterClose = () => {
    resolve(null)
    TopView.hide(TopViewKey)
  }

  // Auto-focus and select text when modal opens
  useEffect(() => {
    if (open && textAreaRef.current) {
      setTimeout(() => {
        if (textAreaRef.current) {
          textAreaRef.current.focus()
          const length = textAreaRef.current.value.length
          textAreaRef.current.setSelectionRange(length, length)
        }
      }, 100)
    }
  }, [open])

  PromptPopup.hide = onCancel

  const { rows = 1, ...restInputProps } = inputProps

  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onAfterClose()
        }
      }}
      placement="center"
      backdrop="opaque"
      classNames={{
        backdrop: 'bg-black/50',
        wrapper: 'z-[9999]'
      }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{title}</ModalHeader>
        <ModalBody>
          {message && <div className="mb-2 text-[var(--color-text-2)]">{message}</div>}
          <Textarea
            ref={textAreaRef}
            placeholder={inputPlaceholder}
            value={value}
            onValueChange={setValue}
            minRows={rows}
            maxRows={20}
            classNames={{
              input: 'max-h-[80vh]'
            }}
            onKeyDown={(e) => {
              const isEnterPressed = e.key === 'Enter'
              if (isEnterPressed && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                onOk()
              }
            }}
            {...restInputProps}
          />
          {extraNode}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onCancel}>
            {t('common.cancel', '取消')}
          </Button>
          <Button color="primary" onPress={onOk}>
            {t('common.ok', '确定')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

const TopViewKey = 'PromptPopup'

export default class PromptPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: PromptPopupShowParams) {
    return new Promise<string>((resolve) => {
      TopView.show(<PromptPopupContainer {...props} resolve={resolve} />, 'PromptPopup')
    })
  }
}
