// Mock back-office identities (Seller Center member, Admin Center and Operations staff).
// The API phase replaces these with the signed-in seller member / staff session.
export const STAFF = {
  seller: { name: 'Avery Stone', role: 'Owner · Northwind Audio', store: 'Northwind Audio', storeInitials: 'NA' },
  admin: { name: 'Riley Chen', role: 'Platform Administrator' },
  ops: { name: 'Theo Grant', role: 'Order & Shipping Manager' },
} as const;
