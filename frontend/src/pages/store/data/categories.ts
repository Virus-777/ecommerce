// Category tree for the store browse pages (All categories, Category page).
// Counts are items in stock now; `soon` marks a planned category/subcategory with no stock yet.
import type { IconName } from '@/ui';
import type { Tint } from '@/data/fixtures';

export interface SubCategory {
  name: string;
  count: number;
  icon: IconName;
  soon?: boolean;
}

export interface TopCategory {
  id: string;
  name: string;
  icon: IconName;
  tint: Tint;
  count: number;
  subs: SubCategory[];
  soon?: boolean;
}

export const CATEGORY_TREE: TopCategory[] = [
  {
    id: 'electronics', name: 'Electronics', icon: 'headphones', tint: '2', count: 1240,
    subs: [
      { name: 'Headphones', count: 128, icon: 'headphones' },
      { name: 'Speakers', count: 96, icon: 'speaker' },
      { name: 'Smart home', count: 210, icon: 'house' },
      { name: 'Wearables', count: 74, icon: 'watch' },
      { name: 'Cameras', count: 0, icon: 'camera', soon: true },
    ],
  },
  {
    id: 'computers', name: 'Computers', icon: 'monitor', tint: '6', count: 860,
    subs: [
      { name: 'Monitors', count: 267, icon: 'monitor' },
      { name: 'Storage', count: 206, icon: 'hard-drive' },
      { name: 'Keyboards', count: 163, icon: 'keyboard' },
      { name: 'Laptops', count: 129, icon: 'laptop' },
      { name: 'Accessories', count: 95, icon: 'usb' },
    ],
  },
  {
    id: 'home', name: 'Home & Kitchen', icon: 'cooking-pot', tint: '3', count: 2105,
    subs: [
      { name: 'Cookware', count: 653, icon: 'cooking-pot' },
      { name: 'Bedding', count: 505, icon: 'bed-double' },
      { name: 'Lighting', count: 400, icon: 'lamp-desk' },
      { name: 'Coffee & tea', count: 316, icon: 'coffee' },
      { name: 'Cleaning', count: 232, icon: 'bot' },
    ],
  },
  {
    id: 'fashion', name: 'Fashion', icon: 'shirt', tint: '4', count: 1830,
    subs: [
      { name: 'Knitwear', count: 567, icon: 'shirt' },
      { name: 'Shoes', count: 439, icon: 'footprints' },
      { name: 'Bags', count: 348, icon: 'shopping-bag' },
      { name: 'Outerwear', count: 275, icon: 'shirt' },
      { name: 'Accessories', count: 201, icon: 'watch' },
    ],
  },
  {
    id: 'sports', name: 'Sports & Outdoors', icon: 'tent', tint: '1', count: 940,
    subs: [
      { name: 'Hiking', count: 291, icon: 'backpack' },
      { name: 'Running', count: 226, icon: 'footprints' },
      { name: 'Yoga', count: 179, icon: 'activity' },
      { name: 'Cycling', count: 141, icon: 'gauge' },
      { name: 'Camping', count: 103, icon: 'tent' },
    ],
  },
  {
    id: 'beauty', name: 'Beauty', icon: 'sparkles', tint: '5', count: 620,
    subs: [
      { name: 'Skincare', count: 192, icon: 'droplet' },
      { name: 'Hair', count: 149, icon: 'scissors' },
      { name: 'Fragrance', count: 118, icon: 'flower-2' },
      { name: 'Bath', count: 93, icon: 'sparkles' },
    ],
  },
  {
    id: 'toys', name: 'Toys & Games', icon: 'puzzle', tint: '3', count: 410,
    subs: [
      { name: 'Puzzles', count: 127, icon: 'puzzle' },
      { name: 'Board games', count: 98, icon: 'layout-grid' },
      { name: 'Building sets', count: 78, icon: 'boxes' },
    ],
  },
  {
    id: 'pets', name: 'Pet Supplies', icon: 'paw-print', tint: '2', count: 330,
    subs: [
      { name: 'Dog', count: 102, icon: 'paw-print' },
      { name: 'Cat', count: 79, icon: 'paw-print' },
      { name: 'Small pets', count: 63, icon: 'paw-print' },
    ],
  },
  { id: 'garden', name: 'Garden & Outdoor', icon: 'flower-2', tint: '1', count: 0, subs: [], soon: true },
  { id: 'automotive', name: 'Automotive', icon: 'car', tint: '6', count: 0, subs: [], soon: true },
];

export const TOTAL_PRODUCTS = 8335;
