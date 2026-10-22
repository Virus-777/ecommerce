import type { SoftwareDb } from '../../spec/software.js';

/** Rows of the software collections (spec tables) */
export type CategoryRow = SoftwareDb['categories'];
export type AppRow = SoftwareDb['apps'];
export type PackRow = SoftwareDb['packs'];
export type RailRow = SoftwareDb['rails'];
export type PurchaseRow = SoftwareDb['purchases'];
export type EntitlementRow = SoftwareDb['entitlements'];
export type ReviewRow = SoftwareDb['reviews'];

/** apps.package and apps.databases: a software_package file as stored (the AppFile of the API) */
export type StoredFile = {
  id: string;
  kind: 'package' | 'database';
  name: string;
  sizeBytes: number;
  uploadedAt: string | null;
};
