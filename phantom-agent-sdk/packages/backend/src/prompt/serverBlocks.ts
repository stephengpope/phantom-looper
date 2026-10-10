// The texts of the blocks only the server can fill — named in an agent's
// system prompt layout, filled by phantom-backend/systemPrompt/SystemPrompt.ts
// when the session is created. Text only, zero logic; the blanks are the
// lists the server fills in.

// ═══ skills_list ═════════════════════════════════════════════════════════════
// {{skillsList}} is one line per skill: "- name: description" (clipped to 60
// chars). No skills = the block vanishes; skill_list is the live view.

export const SKILLS_LIST = `Below is a list of your skills and their descriptions:

{{skillsList}}

The skill_load tool loads a skill by name. The skill_list tool returns the skill list if for some reason you need an updated list.`;

// ═══ secrets_list ════════════════════════════════════════════════════════════
// {{secretsList}} is one line per secret: "- name: description" (clipped to
// 60 chars). No secrets = the block vanishes; secret_list is the live view.

export const SECRETS_LIST = `The user has stored secrets for your use — tokens and credentials, kept encrypted on the server:

{{secretsList}}

The secret_get tool returns a value by name. This list was written when the session started; the secret_list tool returns the most current list should you need to find a newly added secret.`;

// ═══ github_token ════════════════════════════════════════════════════════════
// Present only when agent_git_credentials is on for the project.

export const GITHUB_TOKEN = `A GitHub token is in your environment (GITHUB_TOKEN); git and gh are authenticated with it.`;

// ═══ agent_database ══════════════════════════════════════════════════════════
// Present only when agent_database is on for the project. Facts only —
// what it is, not what to do with it. Two wordings: private (the default),
// and shared with the project's code (agent_database_shared on).

export const AGENT_DATABASE = `You have your own PostgreSQL database for this project. It is private to you — not the project's, and no code in the project can reach it — and it persists across sessions and container restarts. You are its admin. The database_query tool runs SQL in it.`;

export const AGENT_DATABASE_SHARED = `You have your own PostgreSQL database for this project. It persists across sessions and container restarts. You are its admin. The database_query tool runs SQL in it and should be your primary way of accessing it. The project's code can reach the same database should you need to write code that needs access: \`AGENT_DATABASE_URL\` in your environment is the connection string.`;

// ═══ media ═══════════════════════════════════════════════════════════════════
// Present only when agent_media is on for the project AND media storage is
// configured for its organization — the same rule that offers the media
// tools. Facts only.

export const MEDIA = `This project's organization keeps tracked media files (videos, images, audio, documents) in storage. The media_list tool lists them. The media_link tool gives a short-lived link to one file. The media_download tool copies one into /workspace/scratch. The media_upload tool keeps a file from /workspace as a new media file.`;

// ═══ disk_limit ════════════════════════════════════════════════════════════════
// Present only when container_disk_gb is set. {{gb}} is the limit.

export const DISK_LIMIT = `Your workspace is limited to {{gb}} GB of disk. A write past it fails with "Disk quota exceeded": free space (build output, caches, dependencies you can reinstall) and carry on.`;

// ═══ time_date ═══════════════════════════════════════════════════════════════
// {{date}} is today, in the builder's time zone (the `timezone` setting),
// written once when the session starts.

export const TIME_DATE = `Current date: {{date}}.`;

// ═══ soul_md · agents_md ═════════════════════════════════════════════════════
// The repo's root SOUL.md / AGENTS.md, verbatim — no wrapper text. Present
// only when the matching setting (agent_soul / agent_agents_md) is on for
// the project AND the checkout has the file.
