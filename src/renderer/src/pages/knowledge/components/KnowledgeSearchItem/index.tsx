import { FileMetadata, KnowledgeSearchResult } from '@renderer/types'
import React from 'react'

import TextItem from './TextItem'
import VideoItem from './VideoItem'

// Export shared components
export { CopyButtonContainer, KnowledgeItemMetadata } from './components'
export { useCopyText, useHighlightText, useKnowledgeItemMetadata } from './hooks'

interface Props {
  item: KnowledgeSearchResult & {
    file: FileMetadata | null
  }
  searchKeyword: string
}

const SearchItemRenderer: React.FC<Props> = ({ item, searchKeyword }) => {
  const renderItem = () => {
    if (item.metadata.type === 'video') {
      return <VideoItem item={item} searchKeyword={searchKeyword} />
    } else {
      return <TextItem item={item} searchKeyword={searchKeyword} />
    }
  }

  return (
    <div className="w-full relative p-4 bg-[var(--color-background-soft)] rounded-lg group">
      {renderItem()}
    </div>
  )
}

export default React.memo(SearchItemRenderer)
