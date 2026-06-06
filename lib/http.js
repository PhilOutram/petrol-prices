// lib/http.js — tiny promise wrapper around Node's built-in https.
// Used instead of fetch, which can throw ENOTFOUND on some Vercel Node runtimes.
const https = require('https');

// request(url, { method, headers }, body) -> { status, body }
// body may be a string (sent as-is) or an object (JSON-encoded). Content-Type and
// Content-Length are set automatically for a body unless already provided.
function request(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const bodyStr = postBody == null
      ? null
      : (typeof postBody === 'string' ? postBody : JSON.stringify(postBody));
    const headers = { 'Accept': 'application/json', ...(options.headers || {}) };
    if (bodyStr != null) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

module.exports = { request };
