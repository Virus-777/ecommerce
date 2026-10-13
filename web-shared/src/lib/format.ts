/** $1,234.50: prices are USD at launch (plan ch. 21). */
export const money = (n: number) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1,234 */
export const num = (n: number) => Number(n).toLocaleString('en-US');

/** Percent off between a sale price and a was price, rounded. */
export const percentOff = (price: number, was?: number | null) =>
  was && was > price ? Math.round((1 - price / was) * 100) : 0;

/** "Jordan Lee" -> "JL" */
export const initials = (name: string) =>
  String(name).split(' ').map((w) => w[0]).slice(0, 2).join('');

/** A money value as the API sends it: an integer amount in minor units (cents) plus the currency. */
export interface MoneyValue {
  amount: number;
  currency: string;
}

/** Formats an API money value: { amount: 18900, currency: 'USD' } -> "$189.00". Empty for null. */
export const formatMoney = (m?: MoneyValue | null): string => (m ? money(m.amount / 100) : '');

/** Dollars of an API money value (for arithmetic in the UI). */
export const dollars = (m?: MoneyValue | null): number => (m ? m.amount / 100 : 0);
