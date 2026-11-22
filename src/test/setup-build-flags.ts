// Unit tests run the self-hosted Worker, the superset. The build defines this flag as a
// constant; here it is a global, so a test of Cloudflare-only behavior can stub it to false
// where it is read at call time.
(globalThis as { __CRATE_SELF_HOSTED__?: boolean }).__CRATE_SELF_HOSTED__ = true;
