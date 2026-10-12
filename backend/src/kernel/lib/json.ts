/** A JSON value (the spec's json columns, stored as embedded documents and arrays) */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
