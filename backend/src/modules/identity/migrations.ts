/**
 * Identity's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';

/**
 * Staff sign in with email and password only (owner decision 2026-10-14: the server runs offline and only staff use
 * it). On a database made before that decision, staff may still have an authenticator: this removes the staff
 * accounts' 2-step methods, recovery codes, pending 2-step challenges and remembered devices, so they sign in with
 * their password. Member accounts (customers and sellers) keep their 2-step exactly as it was.
 *
 * Invitations made before it get pass_code_attempts 0 and no pass code (the column is required from now on); a staff
 * invitation still pending then needs a new link and pass code from npm run staff-link.
 *
 * Safe to run again: every step only touches what is still there to change.
 */
export const staffWithoutTwoStep: MongoMigration = {
  id: '2026-10-14-staff-without-two-step',
  async up(db) {
    const now = new Date();
    await db.collection('identity.invitations').updateMany({ pass_code_attempts: { $exists: false } }, { $set: { pass_code_attempts: 0, pass_code_hash: null } });

    const staff = await db
      .collection('identity.accounts')
      .find({ realm: 'staff' }, { projection: { _id: 1 } })
      .map((d) => d._id)
      .toArray();
    if (!staff.length) return;
    const ofStaff = { account_id: { $in: staff } };
    await db.collection('identity.two_step_methods').updateMany({ ...ofStaff, removed_at: null }, { $set: { removed_at: now } });
    await db.collection('identity.recovery_codes').deleteMany(ofStaff);
    // the same status repo.supersedeChallenges gives a challenge that can no longer be completed
    await db.collection('identity.challenges').updateMany({ ...ofStaff, purpose: { $in: ['two_step_setup', 'sign_in_second_factor'] }, status: 'pending' }, { $set: { status: 'expired' } });
    await db.collection('identity.devices').updateMany({ ...ofStaff, two_step_trusted_until: { $ne: null } }, { $set: { two_step_trusted_until: null } });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [staffWithoutTwoStep];
