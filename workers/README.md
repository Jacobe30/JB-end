# Cards API Worker

This Cloudflare Worker implements a simple cards API backed by D1.

Features
- CRUD for cards: card_id (UUID), name, phone_numbers (encrypted)
- Phone numbers encrypted with AES-GCM using a Worker secret ENCRYPTION_KEY (base64, 32 bytes)
- Search by name and phone (phone search decrypts rows server-side)

Setup (local)
1. cd workers
2. npm install
3. Set ENCRYPTION_KEY locally for Miniflare: generate 32 random bytes and base64-encode.
   Example (node):
     node -e "console.log(Buffer.from(require('crypto').randomBytes(32)).toString('base64'))"
4. Run Miniflare (requires miniflare installed):
   ENCRYPTION_KEY=<base64> npx miniflare --wrangler-config wrangler.toml

D1 migration
- Migrations live in workers/migrations. Apply them when creating the D1 database in Cloudflare (or with tools that run the SQL).

Secrets & Deployment
- Do NOT commit ENCRYPTION_KEY. In production set it as a Worker secret:
  wrangler secret put ENCRYPTION_KEY
- Configure a D1 database in the Cloudflare dashboard and bind it as CARDS_DB (see wrangler.toml)
- Deploy: wrangler publish

Security notes
- ENCRYPTION_KEY should be rotated by creating a new key, updating the Worker to accept both keys (e.g., try new, fall back to old while migrating rows), then re-encrypt rows gradually.
- Do not log plaintext phone numbers. The Worker avoids printing decrypted phone numbers.
- For production rate-limiting and API access control, place Cloudflare Rate Limits or API Gateway in front and require an API key or JWT.

Example requests
- Create:
  POST /cards { "name": "Alice", "phone_numbers": ["+1234567890"] }
- Get:
  GET /cards/:id
- Search:
  GET /cards?search=Alice

Tests
- A simple test harness is included under workers/test. Use Miniflare to run integration tests.
