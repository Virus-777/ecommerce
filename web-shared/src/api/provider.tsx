import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createApi, type Api } from './client';
import { ApiError } from './errors';
import { createGraphql } from './graphql';
import { Session, type Audience, type SessionSnapshot } from './session';

interface ApiContext {
  session: Session;
  api: Api;
  gql: ReturnType<typeof createGraphql>;
}

const Ctx = createContext<ApiContext | null>(null);

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retry network failures and 5xx/429 a couple of times; never retry a refusal (4xx).
        retry: (count, e) => count < 2 && (!(e instanceof ApiError) || e.status >= 500 || e.status === 429),
      },
      mutations: { retry: false },
    },
  });
}

/**
 * One per app: the session for its audience, the typed REST client, the GraphQL client and the query cache.
 *   <ApiProvider audience="store">…</ApiProvider>
 */
export function ApiProvider({ audience, baseUrl = '', children }: { audience: Audience; baseUrl?: string; children: ReactNode }) {
  const [value] = useState<ApiContext>(() => {
    const session = new Session({ audience, baseUrl });
    return { session, api: createApi(session, baseUrl), gql: createGraphql(session, baseUrl) };
  });
  const [queryClient] = useState(makeQueryClient);
  return (
    <Ctx.Provider value={value}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Ctx.Provider>
  );
}

function useApiContext(): ApiContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApi outside ApiProvider');
  return c;
}

/** The typed REST client: `const { api } = useApi(); call(api.GET('/api/store/cart'))`. */
export const useApi = () => useApiContext();

/** The session state (visitor or signed-in kind and claims), re-rendering on change. */
export function useSessionState(): SessionSnapshot {
  const { session } = useApiContext();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
