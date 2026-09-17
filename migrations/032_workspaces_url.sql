-- `url` was always https://github.com/{owner}/{name}.git — written from
-- owner and name at registration (git/remote.ts remoteUrl) and read by one
-- place, the clone's auth. Two columns saying one thing; the derived one goes.
-- Every reader derives it from owner + name now.
alter table phantom_looper.workspaces drop column url;
