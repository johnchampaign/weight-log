-- HDO account settings. users.unit is now the *log* unit ('kg', 'lb' or
-- 'st'; stone logs are stored in pounds, as in HDO). display_unit is what
-- the UI shows and accepts; it starts equal to the log unit so nothing
-- changes for existing accounts.
ALTER TABLE users ADD COLUMN display_unit TEXT;
ALTER TABLE users ADD COLUMN energy_unit TEXT NOT NULL DEFAULT 'kcal';
ALTER TABLE users ADD COLUMN decimal_char TEXT NOT NULL DEFAULT '.';
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN middle_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
UPDATE users SET display_unit = unit WHERE display_unit IS NULL;
