/**
 * The running version of the bot.
 *
 * BUMP THIS ON EVERY DEPLOY. It is the only thing that tells a live Worker it
 * is new: the cron tick compares it against the last version the database saw
 * (see db.claimVersion) and announces the difference. Deploying without
 * bumping it is silent — which is correct, since nothing about the running
 * code changed as far as anyone can tell from the outside.
 *
 * Deliberately a hand-edited constant rather than something read from
 * package.json or a build stamp: it is a claim about what shipped, and a claim
 * should be made on purpose. It is also shown in /diag, so it is the first
 * thing to check when the bot is behaving like code you thought you replaced.
 */
export const VERSION = '0.35.1';
