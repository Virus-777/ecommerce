import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, Button, PageHeader, PeriodControl, Tabs, usePeriod } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { REPORT, type ReportQuery } from './data/reports';
import { ExportError, MONEY_PERMISSION, STATS, useReportExport } from './data/statistics';
import { EarningsTab } from './statistics/EarningsTab';
import { ProductsTab } from './statistics/ProductsTab';
import { SalesTab } from './statistics/SalesTab';
import { ServiceTab } from './statistics/ServiceTab';

// Statistics (seller/reports, docs/09 §4.2; the sidebar's former "Reports"). One period control for the page (URL
// ?preset=&from=&to=&grain=&compare=) and four tabs (URL ?view=): Sales (order trend, product sales, returns by
// reason), Earnings and profit (seller.earnings), Products (seller.profit_by_product, with unit costs edited in the
// table) and Service (account-health meters and the on-time dispatch trend). Export CSV exports the tab's report for
// the period (POST reports/exports → poll → download). The money tabs need finance.balances.view as well as the
// reports permission; without it they show a note instead of figures.

type Tab = '' | 'earnings' | 'products' | 'service';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: '', label: 'Sales' },
  { value: 'earnings', label: 'Earnings and profit' },
  { value: 'products', label: 'Products' },
  { value: 'service', label: 'Service' },
];

/** The report each tab exports (Service has none: its figures are in the meters and the chart's table). */
const EXPORT_KEY: Record<Tab, string | null> = { '': REPORT.products, earnings: STATS.earnings, products: STATS.profitByProduct, service: null };

export default function Reports() {
  const { can } = useSellerSession();
  const canView = can('reports.seller.view');
  const canMoney = canView && can(MONEY_PERMISSION);
  const canExport = can('reports.seller.export');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const tab: Tab = TABS.some((t) => t.value === view) ? (view as Tab) : '';
  const period = usePeriod();
  // the new presets and comparisons (docs/09 §3.3) are not in the generated types until the backend lands
  const query = period.query as ReportQuery;
  const moneyTab = tab === 'earnings' || tab === 'products';
  const exportKey = moneyTab && !canMoney ? null : EXPORT_KEY[tab];
  const exportCsv = useReportExport(exportKey, query, period.label);

  if (!canView) {
    return (
      <SellerLayout active="reports">
        <PageHeader title="Statistics" sub="Sales, earnings, profit and service figures for your store." />
        <Alert tone="info" title="Statistics aren’t part of your access">
          Ask the store owner to give you the Seller reports permission.
        </Alert>
      </SellerLayout>
    );
  }

  return (
    <SellerLayout active="reports">
      <PageHeader
        title="Statistics"
        sub="Sales, earnings, profit and service figures for your store."
        actions={
          <>
            <PeriodControl period={period} idPrefix="st" />
            {canExport && exportKey && (
              <Button variant="secondary" size="sm" icon="download" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>
                {exportCsv.isPending ? 'Preparing CSV…' : 'Export CSV'}
              </Button>
            )}
          </>
        }
      />
      <Tabs<Tab>
        label="Statistics"
        items={TABS}
        active={tab}
        onChange={(v) => {
          exportCsv.reset();
          setView(v as Exclude<Tab, ''>);
        }}
      />
      {exportCsv.isError && <ExportError error={exportCsv.error} />}
      {tab === '' && <SalesTab query={query} />}
      {tab === 'earnings' && (canMoney ? <EarningsTab query={query} /> : <MoneyNote what="Earnings and profit" />)}
      {tab === 'products' && (canMoney ? <ProductsTab query={query} periodFrom={period.range.from} /> : <MoneyNote what="Profit by product" />)}
      {tab === 'service' && <ServiceTab query={query} />}
    </SellerLayout>
  );
}

/** A member without the balances permission sees what the tab needs instead of an error. */
function MoneyNote({ what }: { what: string }) {
  return (
    <Alert tone="info" title={`${what} isn’t part of your access`}>
      These figures show your store’s earnings, fees and costs, so they need the permission to view balances as well as Seller reports. Ask the store owner if you need them.
    </Alert>
  );
}
