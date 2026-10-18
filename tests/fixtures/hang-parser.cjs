// Fake PDF parser for tests: never finishes, and appends a byte to the file
// named in HEARTBEAT_FILE every few ms so the test can see whether the
// thread is still running after it should have been killed.
const fs = require('node:fs');
module.exports = function hang() {
  const file = process.env.HEARTBEAT_FILE;
  let last = 0;
  for (;;) {
    const now = Date.now();
    if (file && now - last >= 5) { fs.appendFileSync(file, '.'); last = now; }
  }
};
