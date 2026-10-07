// react-test-renderer + `act()` only suppress the "not configured to
// support act(...)" warning when the global flag below is set — there's no
// DOM here to auto-detect a test environment from.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
