# Marketly Admin Center (`@marketly/admin-center`)

For internal staff: the Admin Center (dashboard, notifications, orders, returns, catalog and review queue, categories and brands, reviews moderation, Official Store offers and purchasing, sellers and applications, shipping, payments and payouts, customers, cases and disputes, trust and risk, promotions, content and help articles, advertising, reports, staff and roles, settings, notification templates, action history) and the Operations Center under `/ops` (work queues, stock, receiving, pick and pack, dispatch exceptions, return inspection, daily finance checks).

```
npm run dev:admin      # from the repository root → http://127.0.0.1:3002
```

Pages are in `src/pages/admin/` and `src/pages/ops/`; the layouts (`AdminLayout`, `OpsLayout`) and everything else shared is in [web-shared](../web-shared/README.md). Conventions: [web-shared/docs/PORTING.md](../web-shared/docs/PORTING.md).
