// Loads engine.js (the same logic the web page runs) into Node with the few browser shims it needs.
const fs = require('fs'); const path = require('path'); const os = require('os');
let Component = null;
module.exports = function loadEngine() {
  if (Component) return Component;
  const mem = {};
  if (!global.window) global.window = { localStorage: { getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } }, scrollTo() {} };
  if (!global.navigator) global.navigator = { hardwareConcurrency: os.cpus().length };
  if (!window.pdfjsLibReady) window.pdfjsLibReady = import('pdfjs-dist/legacy/build/pdf.mjs');
  process.removeAllListeners('warning');
  if (!window.XLSX) window.XLSX = require('xlsx');
  class DCLogic { constructor(p) { this.props = p || {}; } setState(s) { Object.assign(this.state, typeof s === 'function' ? s(this.state) : s); } }
  const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  Component = new Function('DCLogic', 'window', 'navigator', src + '\nreturn Component;')(DCLogic, window, navigator);
  return Component;
};
