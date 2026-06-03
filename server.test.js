const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const server = require('./server.js');

test('Server should start and serve static index.html', async (t) => {
  // Start server on an ephemeral port
  server.listen(0);
  const port = server.address().port;
  
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          res.body = data;
          resolve(res);
        });
      }).on('error', reject);
    });

    assert.strictEqual(res.statusCode, 200, 'Expected status code 200 for index.html');
    assert.ok(res.body.includes('<title>StreamVibe IPTV</title>'), 'Expected body to contain the title');
  } finally {
    server.close();
  }
});

test('Proxy should return 400 for missing url parameter', async (t) => {
  server.listen(0);
  const port = server.address().port;
  
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/proxy`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          res.body = data;
          resolve(res);
        });
      }).on('error', reject);
    });

    assert.strictEqual(res.statusCode, 400, 'Expected status code 400 for missing url');
    assert.strictEqual(res.body, 'url parameter must be an absolute http/https URL');
  } finally {
    server.close();
  }
});
