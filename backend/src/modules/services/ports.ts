import type { ServicesDb } from '../../spec/services.js';

/** Rows of the services collections (spec tables) */
export type CategoryRow = ServicesDb['categories'];
export type ProviderRow = ServicesDb['providers'];
export type ServiceRow = ServicesDb['services'];
export type RequestRow = ServicesDb['requests'];
export type ReviewRow = ServicesDb['reviews'];
export type SavedProviderRow = ServicesDb['saved_providers'];
export type DeviceRow = ServicesDb['devices'];
