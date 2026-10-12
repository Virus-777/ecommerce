import type mongoose from 'mongoose';

/** Whether a session is in a running transaction (locks and inbox claims only mean something there) */
export const inTransaction = (session: mongoose.mongo.ClientSession | undefined): session is mongoose.mongo.ClientSession => Boolean(session?.inTransaction());
