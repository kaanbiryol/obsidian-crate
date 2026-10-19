// @ts-check
// Keep the experimental namespace and its ledger intact when updating away from
// the safety build. No binding routes new work here and no alarms are rescheduled.
export class CloudSafety {
  async fetch() {
    return new Response('Cloud safety is inactive in this server build.', { status: 503 });
  }
  async alarm() {}
}
