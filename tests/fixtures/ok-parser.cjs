// Fake PDF parser for tests: echoes the options it was given.
module.exports = async function ok(buf, opts) {
  return { text: `bytes=${buf.length} max=${opts.max}`, numpages: 3 };
};
