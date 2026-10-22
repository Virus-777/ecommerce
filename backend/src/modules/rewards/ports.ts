import type { RewardsDb } from '../../spec/rewards.js';

/** Rows of the rewards collections (spec tables) */
export type ProgramRow = RewardsDb['program'];
export type TaskRow = RewardsDb['tasks'];
export type AccountRow = RewardsDb['accounts'];
export type EntryRow = RewardsDb['entries'];
export type ProgressRow = RewardsDb['progress'];
export type RewardRow = RewardsDb['rewards'];
export type RedemptionRow = RewardsDb['redemptions'];
