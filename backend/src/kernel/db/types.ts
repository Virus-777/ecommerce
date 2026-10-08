import type { ColumnType } from 'kysely';

/** A column the database fills in (identity, bigserial): optional on insert, never updated. */
export type Generated<T> = ColumnType<T, T | undefined, never>;

/** jsonb values */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
