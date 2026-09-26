ALTER TABLE reading_policy ADD COLUMN browser_rendering INTEGER NOT NULL DEFAULT 0 CHECK (browser_rendering IN (0, 1));
