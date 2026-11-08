-- Earned: outcome-priced orders backed by PayPal authorizations.

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  criteria_json TEXT NOT NULL,          -- signed checklist: [{id,text,category}]
  criteria_hash TEXT NOT NULL,          -- sha256 of canonical criteria + brief + terms
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  authorized_cents INTEGER NOT NULL DEFAULT 0,
  captured_cents INTEGER NOT NULL DEFAULT 0,
  released_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                 -- awaiting_approval | authorized | generating | judging | settling | settled | voided | failed | cancelled
  status_detail TEXT,
  paypal_order_id TEXT UNIQUE,
  paypal_authorization_id TEXT,
  paypal_capture_id TEXT,
  paypal_capture_status TEXT,           -- confirmed by webhook
  approve_url TEXT,
  source TEXT NOT NULL DEFAULT 'web',   -- web | agent | mcp
  visitor TEXT,                         -- salted hash, for rate limits only
  lease_until INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  receipt_sig TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX orders_status ON orders(status, updated_at);
CREATE INDEX orders_shop ON orders(shop_id, status);
CREATE INDEX orders_visitor ON orders(visitor, created_at);

CREATE TABLE items (
  order_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  model TEXT NOT NULL,
  task_id TEXT,
  source_url TEXT,                      -- provider URL, used for judging
  media_key TEXT,                       -- our copy in R2
  gen_status TEXT NOT NULL DEFAULT 'pending',  -- pending | submitted | done | failed
  verdict TEXT,                         -- pass | fail
  checks_json TEXT,                     -- per-criterion consensus with each judge's evidence
  transcript TEXT,                      -- text the judges read in the image
  appeal_json TEXT,
  judged_at INTEGER,
  PRIMARY KEY (order_id, idx)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_order ON events(order_id, id);

CREATE TABLE spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  usd_micros INTEGER NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX spend_day ON spend(day);

CREATE TABLE hits (
  visitor TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor, day, kind)
);
