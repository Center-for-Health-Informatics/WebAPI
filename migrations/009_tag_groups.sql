-- Adds hierarchical tag-group support and the group-editor fields Atlas's
-- Tag Management page needs (color/icon/description + the mandatory/showGroup/
-- multiSelection/allowCustom/protected flags), none of which the initial
-- `tag` table had. A tag with parent_id NULL is a "group"; a tag with
-- parent_id set is a member tag of that group (Atlas expects each such tag's
-- DTO to carry a `groups: [<parent DTO>]` array).
ALTER TABLE tag ADD COLUMN parent_id INTEGER REFERENCES tag(id);
ALTER TABLE tag ADD COLUMN description TEXT;
ALTER TABLE tag ADD COLUMN color TEXT;
ALTER TABLE tag ADD COLUMN icon TEXT;
ALTER TABLE tag ADD COLUMN mandatory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tag ADD COLUMN show_group INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tag ADD COLUMN multi_selection INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tag ADD COLUMN allow_custom INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tag ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
