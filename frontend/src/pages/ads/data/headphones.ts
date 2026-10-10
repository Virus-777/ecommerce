// Headphones category sample used by the ad-placements screen (ads/formats).
import type { SellerId, Tint } from '@/data/fixtures';
import type { IconName } from '@/ui';

export interface AdProduct {
  id: string;
  name: string;
  icon: IconName;
  tint: Tint;
  rating: number;
  reviews: number;
  price: number;
  was?: number;
  /** Several offers: the price is "from". */
  from?: boolean;
  free: boolean;
  delivery: string;
  seller: SellerId;
  sponsored?: boolean;
  /** Position in "Recommended" order. */
  rank: number;
  /** Days since listed, for "Newest". */
  age: number;
}

export const HEADPHONES: AdProduct[] = [
  { id: 'lumen-q3', name: 'Lumen Q3 Noise Cancelling Headphones', icon: 'headphones', tint: '3', rating: 4.3, reviews: 421, price: 159, from: true, free: true, delivery: 'Fri, Oct 16', seller: 'pixelport', sponsored: true, rank: 1, age: 40 },
  { id: 'aurora-buds', name: 'Halden Aurora Buds ANC Earbuds', icon: 'ear', tint: '2', rating: 4.5, reviews: 912, price: 139, was: 169, from: true, free: true, delivery: 'Thu, Oct 15', seller: 'official', sponsored: true, rank: 2, age: 22 },
  { id: 'aurora', name: 'Halden Aurora ANC Wireless Headphones', icon: 'headphones', tint: '2', rating: 4.6, reviews: 1284, price: 189, was: 229, from: true, free: true, delivery: 'Thu, Oct 15', seller: 'official', rank: 3, age: 60 },
  { id: 'wave', name: 'Kestrel Wave Over-ear Bluetooth Headphones', icon: 'headphones', tint: '6', rating: 4.2, reviews: 1032, price: 79, from: true, free: true, delivery: 'Fri, Oct 16', seller: 'pixelport', rank: 4, age: 120 },
  { id: 'aria', name: 'Halden Aria True Wireless Earbuds', icon: 'ear', tint: '2', rating: 4.4, reviews: 688, price: 99, was: 129, from: true, free: true, delivery: 'Fri, Oct 16', seller: 'northwind', rank: 5, age: 75 },
  { id: 'studio2', name: 'Halden Studio 2 Wired Monitor Headphones', icon: 'headphones', tint: '5', rating: 4.7, reviews: 356, price: 149, from: true, free: true, delivery: 'Thu, Oct 15', seller: 'official', rank: 6, age: 15 },
  { id: 'wave-pro', name: 'Kestrel Wave Pro ANC Headphones', icon: 'headphones', tint: '6', rating: 4.3, reviews: 577, price: 129, was: 149, from: true, free: true, delivery: 'Fri, Oct 16', seller: 'pixelport', rank: 7, age: 9 },
  { id: 'lumen-q1', name: 'Lumen Q1 On-ear Wireless Headphones', icon: 'headphones', tint: '3', rating: 4.0, reviews: 265, price: 69, from: true, free: true, delivery: 'Fri, Oct 16', seller: 'northwind', rank: 8, age: 200 },
  { id: 'stride', name: 'Corvo Stride Sport Earbuds, Sweat-resistant', icon: 'ear', tint: '4', rating: 4.1, reviews: 540, price: 49, was: 59, free: false, delivery: 'Fri, Oct 16', seller: 'trailhead', rank: 9, age: 33 },
  { id: 'loop', name: 'Kestrel Loop Neckband Earphones', icon: 'ear', tint: '6', rating: 3.9, reviews: 318, price: 39, free: false, delivery: 'Fri, Oct 16', seller: 'pixelport', rank: 10, age: 300 },
  { id: 'kids', name: 'Brightline Kids Volume-limited Headphones', icon: 'headphones', tint: '1', rating: 4.4, reviews: 731, price: 34, from: true, free: false, delivery: 'Wed, Oct 14', seller: 'official', rank: 11, age: 50 },
  { id: 'air', name: 'Halden Air Open-ear Sport Headphones', icon: 'ear', tint: '1', rating: 4.2, reviews: 204, price: 119, free: true, delivery: 'Fri, Oct 16', seller: 'northwind', rank: 12, age: 5 },
];

export const SORTS = ['Recommended', 'Price: low to high', 'Price: high to low', 'Newest', 'Highest rated'] as const;
export type Sort = (typeof SORTS)[number];

export function sortProducts(list: AdProduct[], sort: Sort): AdProduct[] {
  const l = [...list];
  switch (sort) {
    case 'Price: low to high':
      return l.sort((a, b) => a.price - b.price);
    case 'Price: high to low':
      return l.sort((a, b) => b.price - a.price);
    case 'Newest':
      return l.sort((a, b) => a.age - b.age);
    case 'Highest rated':
      return l.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
    default:
      return l.sort((a, b) => a.rank - b.rank);
  }
}
