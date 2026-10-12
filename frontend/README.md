# Marketly Customer Store (`@marketly/store`)

The store website: home, categories, search, product and offers, brand and seller storefronts, deals and collections, cart, checkout, sign-in and registration, My account, help and policies, selling sign-up, ad formats, and the design-system pages (`/design/foundations`, `/design/components`, `/design/patterns`). Below 768 px it uses the Android app layout (tab bar, app bars, sticky action bars, lazy-loading lists, no website footer).

```
npm run dev:store      # from the repository root → http://127.0.0.1:3000
```

Pages are in `src/pages/<area>/`, store layouts in `src/layouts/`, the mock store session in `src/app/session.tsx`. Shared code, the screen catalogue, setup and conventions: [web-shared/README.md](../web-shared/README.md) and [web-shared/docs/PORTING.md](../web-shared/docs/PORTING.md).
