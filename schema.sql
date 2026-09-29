CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'lb',      -- log unit: kg, lb or st (st stored as lb)
  display_unit TEXT,                    -- kg, lb or st; NULL = same as unit
  energy_unit TEXT NOT NULL DEFAULT 'kcal',  -- kcal or kJ
  decimal_char TEXT NOT NULL DEFAULT '.',
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Diet plan (HDO "Diet Calculator"): weights in the user's unit,
  -- calorie balance signed (negative = deficit).
  plan_start_date TEXT,
  plan_start_weight REAL,
  plan_goal_weight REAL,
  plan_calorie_balance INTEGER,
  plan_show INTEGER NOT NULL DEFAULT 1,
  -- Height for body mass index; NULL = not set (BMI hidden).
  height_cm REAL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- weight is nullable: a day may carry only a comment (e.g. "In Iceland"),
-- rung or flag. App enforces that a row has at least one of them.
CREATE TABLE IF NOT EXISTS weights (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  weight REAL,
  comment TEXT,
  rung INTEGER,                        -- exercise ladder rung 1-48
  flag INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
