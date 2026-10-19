import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { ApiProvider } from '@marketly/web-shared/api';
import { BackOfficeNotFound, createAppRouter } from '@marketly/web-shared/routes';
import './fonts.css';
import '@marketly/web-shared/styles/marketly.css';
import '@marketly/web-shared/styles/app.css';
import { StaffSessionProvider } from './app/session';
import { PAGES } from './routes/pages';

// Inert placeholder links (actions that have no screen yet) must not jump to the top.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.('a[href="#"]');
  if (a) e.preventDefault();
});

// Public staff pages opened from the links that bootstrap-owner / staff-link print (no design file).
const Invitation = lazy(() => import('./app/Invitation'));
const ResetPassword = lazy(() => import('./app/ResetPassword'));

const router = createAppRouter({
  pages: PAGES,
  extraRoutes: [
    { path: '/invitation', element: <Invitation /> },
    { path: '/reset-password', element: <ResetPassword /> },
  ],
  notFound: () => <BackOfficeNotFound area="admin" />,
  wrap: (children) => <StaffSessionProvider>{children}</StaffSessionProvider>,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider audience="admin">
      <RouterProvider router={router} />
    </ApiProvider>
  </StrictMode>,
);
