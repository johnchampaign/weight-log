-- Make weights.weight nullable and add comment column (SQLite table rebuild).
CREATE TABLE weights_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  weight REAL,
  comment TEXT,
  PRIMARY KEY (user_id, date)
);
INSERT INTO weights_new (user_id, date, weight, comment)
  SELECT user_id, date, weight, NULL FROM weights;
DROP TABLE weights;
ALTER TABLE weights_new RENAME TO weights;
