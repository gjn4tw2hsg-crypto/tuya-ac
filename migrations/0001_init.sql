-- Key/value store: settings, cached Tuya token, cached weather, AC model info.
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Automation rules. `def` is the rule definition (JSON), `state` is what the
-- engine remembers between ticks (last fired, last condition result, ...).
CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  def TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

-- Extra Tuya temperature sensors. Codes/scales are detected from the device model.
CREATE TABLE sensors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  temp_code TEXT,
  temp_scale INTEGER NOT NULL DEFAULT 0,
  hum_code TEXT,
  hum_scale INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

-- Time series. source = 'ac' | 'outside' | 'sensor:<id>'.
CREATE TABLE readings (
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  temp REAL,
  humidity REAL,
  power INTEGER,
  target REAL,
  mode TEXT
);
CREATE INDEX readings_source_ts ON readings (source, ts);
CREATE INDEX readings_ts ON readings (ts);

-- Activity log: what rules did, manual commands, errors.
CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX log_ts ON log (ts);
