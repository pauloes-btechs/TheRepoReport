import { HashRouter, Route, Routes } from 'react-router-dom';
import { Layout, ThemeSync } from './components/Layout';
import { SiteDataProvider } from './lib/site-data';
import { AboutPage, NotFoundPage } from './pages/AboutPage';
import { ArchivePage } from './pages/ArchivePage';
import { EditionPage } from './pages/EditionPage';
import { HomePage } from './pages/HomePage';
import { ReposPage } from './pages/ReposPage';
import { SettingsPage } from './pages/SettingsPage';
import { PlayerProvider } from './player/PlayerContext';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/edition/:key" element={<EditionPage />} />
      <Route path="/repos" element={<ReposPage />} />
      <Route path="/archive" element={<ArchivePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <SiteDataProvider>
      <PlayerProvider>
        <ThemeSync />
        <HashRouter>
          <Layout>
            <AppRoutes />
          </Layout>
        </HashRouter>
      </PlayerProvider>
    </SiteDataProvider>
  );
}
