import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { customer } from '@/data/fixtures';

// Mock session shared across pages (signed-in shopper, cart count, staff identities).
// The API phase replaces this with the identity/cart modules (visitor token -> shopper session).

export const STAFF = {
  seller: { name: 'Avery Stone', role: 'Owner · Northwind Audio', store: 'Northwind Audio', storeInitials: 'NA' },
  admin: { name: 'Riley Chen', role: 'Platform Administrator' },
  ops: { name: 'Theo Grant', role: 'Order & Shipping Manager' },
} as const;

interface Session {
  signedIn: boolean;
  setSignedIn: (v: boolean) => void;
  customer: typeof customer;
  cartCount: number;
  setCartCount: (n: number) => void;
  unreadNotifications: number;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(true);
  const [cartCount, setCartCount] = useState(4);
  const value = useMemo(() => ({ signedIn, setSignedIn, customer, cartCount, setCartCount, unreadNotifications: 3 }), [signedIn, cartCount]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
