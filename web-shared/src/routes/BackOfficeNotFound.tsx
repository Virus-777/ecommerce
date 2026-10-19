import { BackOfficeLayout, type BoArea } from '../layouts/BackOfficeLayout';
import { Button, EmptyState } from '../ui';
import { href } from './href';

/** Unknown URL inside Seller Center or Admin Center (the store has its own designed 404 page). */
export function BackOfficeNotFound({ area }: { area: Exclude<BoArea, 'ops'> }) {
  return (
    <BackOfficeLayout area={area}>
      <EmptyState
        as="h1"
        icon="map-pin-off"
        title="Page not found"
        action={
          <Button to={href(area === 'seller' ? 'seller/dashboard' : 'admin/dashboard')} icon="layout-dashboard">
            Go to the dashboard
          </Button>
        }
      >
        The link may be old, or the page was moved. Check the address or start from the dashboard.
      </EmptyState>
    </BackOfficeLayout>
  );
}
