/*
 * One background job = one short-lived child process (forked by queue.js). It receives the job over IPC, runs the
 * headless pipeline, streams progress back, sends the result and exits — so a crash, a stuck OCR page or a memory
 * spike can never take the API server down, and memory is returned after every statement.
 */
const { analyze } = require('../pipeline');

let last = 0;
process.on('message', async (m) => {
  if (!m || m.type !== 'run') return;
  const onLog = (level, step, msg) => {
    const t = Date.now(); if (level === 'INFO' && t - last < 250) return; last = t; // at most ~4 updates a second
    process.send({ type: 'progress', stage: step, message: String(msg).slice(0, 300), level });
  };
  let r;
  try {
    r = await analyze({ files: m.files, password: m.password || null, llm: !!m.options.llm, reviewMode: m.options.review_mode, customRules: m.options.custom_rules || null, onLog });
  } catch (e) { r = { ok: false, code: e.code || 'ERROR', error: e.message || String(e) }; }
  process.send({ type: 'done', result: r }, () => process.exit(0));
});
process.send({ type: 'ready' });
