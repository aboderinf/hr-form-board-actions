const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('total bases UI lives only in standalone site directory', () => {
  assert.equal(fs.existsSync(path.join(root, 'total-bases.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'total-bases.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'sites', 'total-bases', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(root, 'sites', 'total-bases', 'app.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'sites', 'total-bases', 'style.css')), true);
  assert.equal(fs.existsSync(path.join(root, 'sites', 'total-bases', 'vercel.json')), true);
});

test('standalone site uses shared read-only data APIs', () => {
  const client = fs.readFileSync(path.join(root, 'sites', 'total-bases', 'app.js'), 'utf8');
  assert.match(client, /hr-form-board-actions\.vercel\.app\/api\/total-bases-form/);
  assert.match(client, /hr-form-board-actions\.vercel\.app\/api\/total-bases-discovery/);
  assert.doesNotMatch(client, /SPORTSGAMEODDS_API_KEY/);
  assert.doesNotMatch(client, /api\.sportsgameodds\.com/);
});

test('standalone site opens on actionable picks and keeps research separate', () => {
  const html = fs.readFileSync(path.join(root, 'sites', 'total-bases', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'sites', 'total-bases', 'app.js'), 'utf8');
  const execution = fs.readFileSync(path.join(root, 'sites', 'total-bases', 'monetization.js'), 'utf8');

  assert.match(html, /class="tab active" data-view="picks">Today’s Picks/);
  assert.match(html, /data-view="model">Model Research/);
  assert.match(client, /let activeView = 'picks'/);
  assert.match(client, /if \(activeView === 'picks'\)/);
  assert.match(execution, /querySelector\('\.tab\[data-view="picks"\]'\)/);
  assert.match(execution, /showMoney\(true\);\s*$/);
});

test('form hydration is bulk rather than one MLB request per batter', () => {
  const handler = fs.readFileSync(path.join(root, 'lib', 'total-bases-form-handler-v2.js'), 'utf8');
  assert.match(handler, /personIds/);
  assert.match(handler, /type=\[gameLog\]/);
  assert.match(handler, /BULK_SIZE = 40/);
  assert.doesNotMatch(handler, /people\/\$\{batterId\}\/stats/);
});

test('discovery mines archived checkpoints without a thirteenth serverless function', () => {
  const discovery = fs.readFileSync(path.join(root, 'lib', 'total-bases-discovery-handler.js'), 'utf8');
  const oddsApi = fs.readFileSync(path.join(root, 'api', 'strikeouts-odds.js'), 'utf8');
  const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
  assert.equal(fs.existsSync(path.join(root, 'api', 'total-bases-discovery.js')), false);
  assert.match(discovery, /readTotalBasesCheckpoint/);
  assert.match(discovery, /providerRequests: 0/);
  assert.match(discovery, /holdoutStart/);
  assert.match(discovery, /ambiguousDoubleheaders/);
  assert.match(discovery, /String\(split\?\.date \|\| ''\) < slateDate/);
  assert.match(oddsApi, /total-bases-discovery/);
  assert.match(vercel, /\/api\/total-bases-discovery/);
  assert.doesNotMatch(discovery, /SPORTSGAMEODDS_API_KEY/);
  assert.doesNotMatch(discovery, /api\.sportsgameodds\.com/);
});
