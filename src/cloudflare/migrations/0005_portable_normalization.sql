INSERT INTO maintenance_state (key, value) VALUES ('portable_paths_ready', 'false') ON CONFLICT(key) DO UPDATE SET value = 'false';
