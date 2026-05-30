// Diagnostic: capture raw Signal envelopes to inspect the `source` field
// for different senders in the Mercury group.
const API = process.env.SIGNAL_API || 'http://localhost:8080';
const NUMBER = process.env.SIGNAL_NUMBER || '+919596087691';
const DURATION_MS = 90_000;

console.log(`Listening for ${DURATION_MS / 1000}s on ${API} for ${NUMBER}`);
console.log('>>> Now send messages in the Mercury group:');
console.log('    1. One from YOUR phone (the owner)');
console.log('    2. One from a DIFFERENT member\n');

const deadline = Date.now() + DURATION_MS;

while (Date.now() < deadline) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${API}/v1/receive/${encodeURIComponent(NUMBER)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const envelopes = await res.json();
    for (const e of envelopes) {
      const env = e.envelope || e;
      const payload = env.dataMessage || env.syncMessage?.sentMessage;
      console.log('─────────────────────────────────────────');
      console.log('source        :', env.source);
      console.log('sourceNumber  :', env.sourceNumber);
      console.log('sourceUuid    :', env.sourceUuid);
      console.log('sourceName    :', env.sourceName);
      console.log('kind          :', env.dataMessage ? 'dataMessage' : env.syncMessage ? 'syncMessage' : 'other');
      console.log('text          :', payload?.message);
      console.log('groupId       :', payload?.groupInfo?.groupId);
      console.log('FULL ENVELOPE :', JSON.stringify(env));
    }
  } catch (err) {
    // timeout = no messages, keep polling
  }
}
console.log('\nDone.');
