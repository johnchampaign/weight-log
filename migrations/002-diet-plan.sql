-- Diet plan (HDO "Diet Calculator"): weights in the user's unit,
-- calorie balance signed (negative = deficit).
ALTER TABLE users ADD COLUMN plan_start_date TEXT;
ALTER TABLE users ADD COLUMN plan_start_weight REAL;
ALTER TABLE users ADD COLUMN plan_goal_weight REAL;
ALTER TABLE users ADD COLUMN plan_calorie_balance INTEGER;
ALTER TABLE users ADD COLUMN plan_show INTEGER NOT NULL DEFAULT 1;
