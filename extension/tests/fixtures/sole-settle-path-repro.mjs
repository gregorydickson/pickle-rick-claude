#!/usr/bin/env node
// Fixture: the minimal shape shared by every timer this bundle ref'd — a Promise whose
// SOLE settle path is a `setTimeout` callback, guarded by a `settled` flag, with literally
// no other handle in the process (a "handle-free child": no real spawn, no other timer, no
// I/O). Toggled via PICKLE_TEST_UNREF_TIMER: '1' unref's the timer (the pre-fix shape),
// anything else leaves it ref'd (the shipped shape). Prints SETTLED only if the timer fires.
const unref = process.env.PICKLE_TEST_UNREF_TIMER === '1';
let settled = false;
const p = new Promise((resolve) => {
  const timer = setTimeout(() => {
    settled = true;
    resolve();
  }, 50);
  if (unref) { timer.unref(); }
});
await p;
console.log(`SETTLED ${settled}`);
