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
