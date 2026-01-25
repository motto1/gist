import { Button, Input, Space, Tag, Typography } from 'antd'
import { Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'

export type CharacterInputProps = {
  value: string[]
  onChange: (characters: string[]) => void
  placeholder?: string
  maxCharacters?: number
  showQuickAdd?: boolean
  suggestions?: string[]
}

export function CharacterInput({
  value,
  onChange,
  placeholder,
  maxCharacters,
  showQuickAdd = false,
  suggestions = []
}: CharacterInputProps) {
  const [inputValue, setInputValue] = useState('')

  const normalizedValue = useMemo(() => value.map((v) => v.trim()).filter(Boolean), [value])

  const canAddMore = maxCharacters === undefined || normalizedValue.length < maxCharacters

  const addCharacter = useCallback(
    (raw: string) => {
      const next = raw.trim()
      if (!next) return
      if (!canAddMore) return

      if (normalizedValue.includes(next)) {
        setInputValue('')
        return
      }

      onChange([...normalizedValue, next])
      setInputValue('')
    },
    [canAddMore, normalizedValue, onChange]
  )

  const removeCharacter = useCallback(
    (character: string) => {
      onChange(normalizedValue.filter((c) => c !== character))
    },
    [normalizedValue, onChange]
  )

  return (
    <Container>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <InputRow>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCharacter(inputValue)
              }
            }}
            placeholder={placeholder}
            disabled={!canAddMore}
            allowClear
          />
          <Button
            type="default"
            icon={<Plus size={14} />}
            onClick={() => addCharacter(inputValue)}
            disabled={!canAddMore || !inputValue.trim()}
          >
            添加
          </Button>
        </InputRow>

        {maxCharacters !== undefined && (
          <Typography.Text type={canAddMore ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
            {normalizedValue.length}/{maxCharacters}
          </Typography.Text>
        )}

        {normalizedValue.length > 0 && (
          <TagsWrap>
            {normalizedValue.map((character) => (
              <Tag key={character} closable onClose={() => removeCharacter(character)}>
                {character}
              </Tag>
            ))}
          </TagsWrap>
        )}

        {showQuickAdd && suggestions.length > 0 && (
          <QuickAddWrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              快速添加
            </Typography.Text>
            <TagsWrap>
              {suggestions.map((s) => {
                const disabled = normalizedValue.includes(s) || !canAddMore
                return (
                  <Tag
                    key={s}
                    color={disabled ? 'default' : 'blue'}
                    style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}
                    onClick={() => {
                      if (!disabled) addCharacter(s)
                    }}
                  >
                    {s}
                  </Tag>
                )
              })}
            </TagsWrap>
          </QuickAddWrap>
        )}
      </Space>
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
`

const InputRow = styled.div`
  display: flex;
  gap: 8px;
  width: 100%;

  .ant-input-affix-wrapper,
  .ant-input {
    flex: 1;
  }

  button {
    -webkit-app-region: no-drag;
  }
`

const TagsWrap = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  .ant-tag {
    margin-inline-end: 0;
  }
`

const QuickAddWrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

