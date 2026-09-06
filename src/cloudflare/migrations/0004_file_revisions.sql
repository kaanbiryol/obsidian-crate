ALTER TABLE changelog ADD COLUMN revision TEXT;
UPDATE changelog SET revision = (SELECT storage_key FROM files WHERE files.path = changelog.path AND files.hash = changelog.hash) WHERE action = 'put';
