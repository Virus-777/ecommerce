import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { BackOfficeNotFound, createAppRouter } from '@marketly/web-shared/routes';
import '@marketly/web-shared/styles/marketly.css';
import '@marketly/web-shared/styles/app.css';
import { PAGES } from './routes/pages';

// Inert placeholder links (actions that have no screen yet) must not jump to the top.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.('a[href="#"]');
  if (a) e.preventDefault();
});

const router = createAppRouter({ pages: PAGES, notFound: () => <BackOfficeNotFound area="admin" /> });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
