import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';

import '@/app/globals.css';
import { RadiationSimulator } from '@/components/radiation-simulator';

const root = document.getElementById('root');

if (!root) throw new Error('Simulator root element is missing.');

createRoot(root).render(
  <StrictMode>
    <RadiationSimulator />
  </StrictMode>,
);
