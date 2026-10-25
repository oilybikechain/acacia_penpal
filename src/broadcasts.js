// Broadcast jobs also retain the announcement and its original audience so new
// recipients can be added later without re-sending it to existing recipients.
function prepareBroadcastHistory(s) {
  for (const job of Object.values(s.jobs)) {
    if (job.kind !== 'broadcast') continue;
    // Older jobs stored text only on recipient items. Empty old jobs cannot
    // recover their text, so leave them without replayable content.
    job.text ??= job.items[0]?.text;
    if (job.batch !== undefined && job.audienceProfileIds === undefined) {
      job.audienceProfileIds = [...(s.batches[job.batch]?.profileIds || [])];
    }
  }
}

function queueMissedBroadcasts(s) {
  prepareBroadcastHistory(s);
  for (const job of Object.values(s.jobs)) {
    if (job.kind !== 'broadcast' || job.text === undefined) continue;
    const recipients = new Set(job.items.map(item => item.userId));
    const audience = job.batch === undefined ? null : new Set(job.audienceProfileIds);
    for (const account of Object.values(s.accounts)) {
      if (recipients.has(account.id) || (audience && !audience.has(account.profileId))) continue;
      job.items.push({ userId: account.id, text: job.text, status: 'pending', attempts: 0 });
      recipients.add(account.id);
    }
  }
}

module.exports = { prepareBroadcastHistory, queueMissedBroadcasts };
