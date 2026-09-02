/* Simple integration test using Miniflare
Run: cd workers && npm install && node test/test.js
*/
const assert = require('assert');
const { Miniflare } = require('miniflare');
const fs = require('fs');

async function run() {
  // generate a temp encryption key (base64 32 bytes)
  const key = Buffer.from(require('crypto').randomBytes(32)).toString('base64');

  const mf = new Miniflare({
    scriptPath: './src/index.js',
    wranglerConfigPath: './wrangler.toml',
    d1Databases: {
      CARDS_DB: {
        dsn: 'file:./test/cards-test.sqlite',
        migrationsPath: './migrations'
      }
    },
    bindings: {
      ENCRYPTION_KEY: key
    }
  });

  const createResp = await mf.dispatchFetch('http://localhost/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test User', phone_numbers: ['+15551234567'] })
  });
  assert.strictEqual(createResp.status, 201, 'Expected 201 on create');
  const body = await createResp.json();
  assert.ok(body.card_id, 'card_id present');

  const getResp = await mf.dispatchFetch(`http://localhost/cards/${body.card_id}`);
  assert.strictEqual(getResp.status, 200);
  const got = await getResp.json();
  assert.strictEqual(got.name, 'Test User');
  assert.deepStrictEqual(got.phone_numbers, ['+15551234567']);

  console.log('Basic create/get test passed');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(2); });
