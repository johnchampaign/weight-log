-- Exercise ladder rung (1-48, NULL = none) and day flag, as in HDO's log.
ALTER TABLE weights ADD COLUMN rung INTEGER;
ALTER TABLE weights ADD COLUMN flag INTEGER NOT NULL DEFAULT 0;
