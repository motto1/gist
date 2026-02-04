import '@renderer/databases'

import { AnimatePresence, motion } from 'motion/react'
import { FC } from 'react'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import WindowControls from './components/WindowControls'
import NavigationHandler from './handler/NavigationHandler'
import { useNavbarPosition } from './hooks/useSettings'
import AgentsPage from './pages/agents/AgentsPage'
import CodeToolsPage from './pages/code/CodeToolsPage'
import NovelCompressionPage from './pages/compress/NovelCompressionPage'
import FilesPage from './pages/files/FilesPage'
import HomePage from './pages/home/HomePage'
import GistVideoRoutePage from './pages/gistVideo/GistVideoRoutePage'
import KnowledgePage from './pages/knowledge/KnowledgePage'
import LaunchpadPage from './pages/launchpad/LaunchpadPage'
import MinAppPage from './pages/minapps/MinAppPage'
import MinAppsPage from './pages/minapps/MinAppsPage'
import NotesPage from './pages/notes/NotesPage'
import NovelCharacterPage from './pages/novelCharacter/NovelCharacterPage'
import NovelOutlinePage from './pages/novelOutline/NovelOutlinePage'
import PaintingsRoutePage from './pages/paintings/PaintingsRoutePage'
import SettingsPage from './pages/settings/SettingsPage'
import TextEditorPage from './pages/textEditor/TextEditorPage'
import TextReaderPage from './pages/textReader/TextReaderPage'
import TranslatePage from './pages/translate/TranslatePage'
import {
  CharacterWorkflow,
  LauncherPage,
  OutlineWorkflow,
  SpeedReadWorkflow,
  TTSGenerator
} from './pages/workflow'

const AppRoutes: FC = () => {
  const location = useLocation()

  return (
    <ErrorBoundary>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${location.pathname}${location.search}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeInOut' }}
          className="h-full w-full"
        >
          <Routes location={location}>
            <Route path="/" element={<LauncherPage />} />
            <Route path="/workflow/speed-read" element={<SpeedReadWorkflow />} />
            <Route path="/workflow/character" element={<CharacterWorkflow />} />
            <Route path="/workflow/outline" element={<OutlineWorkflow />} />
            <Route path="/workflow/tts" element={<TTSGenerator />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/paintings/*" element={<PaintingsRoutePage />} />
            <Route path="/translate" element={<TranslatePage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/gist-video" element={<GistVideoRoutePage />} />
            <Route path="/apps/:appId" element={<MinAppPage />} />
            <Route path="/apps" element={<MinAppsPage />} />
            <Route path="/novel-character" element={<NovelCharacterPage />} />
            <Route path="/novel-outline" element={<NovelOutlinePage />} />
            <Route path="/code" element={<CodeToolsPage />} />
            <Route path="/compress" element={<NovelCompressionPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/launchpad" element={<LaunchpadPage />} />
            <Route path="/text-editor" element={<TextEditorPage />} />
            <Route path="/text-reader/:bookId" element={<TextReaderPage />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </ErrorBoundary>
  )
}

const Router: FC = () => {
  const { navbarPosition } = useNavbarPosition()

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <Sidebar />
        <AppRoutes />
        <WindowControls />
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <NavigationHandler />
      <TabsContainer>
        <AppRoutes />
      </TabsContainer>
    </HashRouter>
  )
}

export default Router
