CREATE TABLE IF NOT EXISTS model_usage (
  hour INTEGER NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live', 'gateway-import')),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (hour, model, source)
);
