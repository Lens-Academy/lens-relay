import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { initTheme } from './lib/theme';
import '@fontsource-variable/source-serif-4/opsz.css';
import './index.css';

// Light or dark before the first paint, so a dark page doesn't flash white
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
