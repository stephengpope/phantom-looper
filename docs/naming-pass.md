# Naming pass — every short name, what it really is, what it will be called

Rule: a name says what the thing is. Nothing is renamed until its row here
is approved. One section per file; `line` is where it is declared today.
Files the plan deletes (`core/llm/*`, `looper/turn.ts`, `looper/injectFetch.ts`,
`core/session.ts`, `api/backdoor.ts`) are not listed.

## Conventions proposed — approve or strike each

| # | Today | Proposal | Why |
|---|---|---|---|
| C1 | `catch (e)` | `catch (error)` everywhere | one word, always the same |
| C2 | `(e) =>` in `.catch(...)` | `(error) =>` | same |
| C3 | `(r) => setTimeout(r, ms)` | `(wake) => setTimeout(wake, ms)` | it is the function that ends the sleep |
| C4 | `for (let i = 0; i < n; i++)` index loops | **keep `i`/`j`** | the one convention every reader knows; a word adds nothing |
| C5 | `.sort((a, b) => …)` comparators | **keep `a`/`b`** | the universal comparator idiom; the comparison line says what they are |
| C6 | `id`, `by`, `at`, `on`, `ok`, `db`, `tx` (transaction) | **keep** | real words / the standard names |
| C7 | `req`, `reply`, `ctx`, `deps`, `opts`, `log` | **keep** | the framework's and the codebase's standard names |
| C8 | `(v) =>` where v is a setting/column VALUE | `(value) =>` | |
| C9 | `(k) =>` where k is a setting/record KEY | `(key) =>` | |

Everything below assumes C1–C9. Rows whose only change is a convention
are listed once per file as "C1 ×n" so the table stays readable.

---

## phantom-backend/sessions.ts

| line | old | new | what it is |
|---|---|---|---|
| 105–167, 220, 568–569, 588–589, 597, 655, 687, 703, 764, 835, 862 | `s` | `session` | the session row |
| 144 | `l` | `line` | one line of the transcript text |
| 212–213 | `s` | `created` | the row just created |
| 237 | `ac` | `abort` | the running turn's AbortController |
| 258 | `v` | `raw` | the raw column value drizzle hands `mapWith` |
| 283, 297 | `m` | `model` | the provider/model pair resolved for a newborn session |
| 295 | `s` | `session` | each session row in the loop |
| 319 | `n` | `skipped` | how many lines have been skipped so far |
| 320 | `nl` | `newlineAt` | index of the next newline |
| 355 | `q` | `query` | the list query |
| 364 | `c` | `char` | the LIKE metacharacter being escaped |
| 421 | `r` | `row` | a session row |
| 587, 599 | `t` | `target` | where the assistant's row points (project + workspace) |
| 705 | `l` | `line` | one typed record line being serialized |
| 740 | `r` | `row` | the updated session row |
| 852 | `m` | `model` | the provider/model pair stamped on the row |

## phantom-backend/settings.ts

| line | old | new | what it is |
|---|---|---|---|
| 213, 219 | `k`, `p` | `name`, `provider` | a credential name; a provider name |
| 220 | `n` | `credential` | each credential name searched |
| 364 | `v` | `timezone` | the timezone string being checked |
| 367 | `ms` | `millisecondsSetting` | builder of a ms-unit setting's meta |
| 463, 503, 517, 560–566, 714, 726, 746, 818–819, 881–923 | `k` | `key` | a setting key (C9) |
| 474, 504 | `m` | `meta`, `problem` | a setting's meta; a validation message |
| 503 | `v` | `value` | the value being validated (C8) |
| 641 | `s` | `secrets` | the secret list being sorted |
| 645, 761, 772 | `l` | `layers` | the resolved default/global/project layers of one key |
| 660 | `d` | `latest` | the newest model for the provider |
| 693, 958 | `s` | `scope` | a settings scope name |
| 697, 959 | `r` | `row` | a settings row |
| 762 | `v` | `value` | the winning layer's value |
| 812, 820 | `a` | `agent` | an agent type name |
| 817 | `v` | `resolved` | the resolved values map |
| 957 | `r` | `row` | a settings row |

## phantom-backend/index.ts

| line | old | new | what it is |
|---|---|---|---|
| 88–465 | `e` ×14 | `error` | C1/C2 |
| 95–96 | `r` | `record` | one token-usage record |
| 127, 195 | `f` | `serverFetch` | the in-process fetch (goes with injectFetch) |
| 143 | `t` | `text` | a retry notice's text |
| 180, 222–236 | `e` | `event` | a sync / auto-push / auto-pull event |
| 224, 235 | `r` | `result` | the push / pull result |
| 291 | `ms` | `idleMs` | idle threshold in milliseconds |
| 306, 439 | `ms` | `intervalMs` | the loop's interval |
| 307, 318, 368, 440–441 | `r` | `wake` | C3 |
| 365 | `i` | keep | C4 |
| 390 | `e` | `event` | a settings event |

## phantom-backend/projects.ts — `e` C1 only.

## phantom-backend/cards.ts

| line | old | new | what it is |
|---|---|---|---|
| 85 | `q` | `query` | the dynamic select being built |
| 132, 166 | `f` | `field` | a card field name |
| 135, 181 | `tx` | keep | C6 |
| 158, 218–231 | `o` | `op` | one requirements-list operation |
| 221, 226, 232 | `e` | `item` | one requirements item |
| 231–232 | `i`, `j` | `index`, `position` | the op's target index; each item's position |

## phantom-backend/workspaces.ts

| line | old | new | what it is |
|---|---|---|---|
| 114, 129 | `e` | `error` | C1 |
| 204 | `r` | `row` | a workspace row |

## phantom-backend/crons.ts

| line | old | new | what it is |
|---|---|---|---|
| 57 | `c` | `cron` | the croner job built to validate a schedule |
| 67, 141, 168 | `e` | `error` | C1 |
| 88, 91 | `l` | `listener` | a change listener |
| 186 | `p`, `m` | `provider`, `model` | the raw provider / model inputs |
| 218, 237, 245 | `v` | `raw` | the raw input being cleaned |
| 226 | `p`, `s` | `prompt`, `script` | the raw prompt / script inputs |

## phantom-backend/presets.ts

| line | old | new | what it is |
|---|---|---|---|
| 15, 36, 39 | `k`, `v` | `key`, `value` | C8/C9 |
| 53 | `e` | `error` | C1 |

## phantom-backend/backgroundTasks.ts — 67 `r` → `row`.
## phantom-backend/logTokens.ts — 23 `r` → `record`.

## phantom-backend/databases.ts

| line | old | new | what it is |
|---|---|---|---|
| 81–101 | `v` | `text` | a column's text representation from Postgres |
| 83 | `b` | `big` | the parsed BigInt |
| 107 | `v` | `value` | a cell value |
| 110 | `s` | `json` | the cell serialized |
| 116–117 | `s` | `identifier`, `literal` | what each quotes |
| 151 | `u` | `url` | the server URL being rewritten |
| 165 | `p` | `ensuring` | the in-flight ensure promise |
| 213, 244 | `o` | `options` | query options |
| 228, 235 | `q` | `query` | the pg Query |
| 235, 239–240 | `r` | `result` | one statement result |
| 240 | `f` | `field` | a result field |
| 241, 244 | `n`, `i` | `name`, `index` | a column name and its position |
| 247, 249 | `e`, `pe` | `error`, `pgError` | C1; the error read as pg's shape |

## phantom-backend/disk.ts

| line | old | new | what it is |
|---|---|---|---|
| 67, 84 | `d` | `disk` | the disk state |
| 76 | `st` | `stats` | statfs result |
| 93, 99, 120–235 | `s` | `session` | the session row |
| 100, 111, 170, 189–192, 233 | `e` | `error` | C1 |
| 120, 185 | `r` | `result` | the backup result |
| 132 | `v` | `version` | the app version |
| 160–185 | `d` | `deps` | C7 |
| 174 | `a`, `b` | keep | C5 |
| 219, 230 | `p` | `paths` | the volume paths |

## phantom-backend/images.ts

| line | old | new | what it is |
|---|---|---|---|
| 26 | `m` | `match` | the version regex match |
| 35 | `i` | `colonAt` | index of the tag separator |
| 75 | `e` | `event` | a pull progress event |
| 101 | `b` | `layer` | one layer's byte progress |
| 130, 141 | `p` | `progress` | pull progress |
| 133 | `p` | `pulling` | the pull promise chained after removal |
| 143, 195 | `e` | `error` | C1 |
| 177 | `r` | `release` | the parsed release of a tag |
| 181, 189 | `c` | `container`, `image` | a container; a live image |

## phantom-backend/system.ts

| line | old | new | what it is |
|---|---|---|---|
| 61, 75 | `e` | `event` | an update event |
| 61 | `o` | `options` | update options |
| 100, 123, 186 | `d`, `e` | `chunk`, `error` | a log data chunk; C1 |
| 115 | `q` | `query` | the logs query |
| 129 | `re` | `pattern` | the grep RegExp |
| 142–147 | `c`, `a`, `b`, `i` | `cpu`, `before`, `after`, keep | a cpu's times; two samples; C4 |
| 144 | `r` | `wake` | C3 |
| 154 | `n` | `load` | a load average number |
| 171, 173, 175 | `e`, `c` | `error`, `container` | C1; a listed container |

## phantom-backend/skills.ts

| line | old | new | what it is |
|---|---|---|---|
| 46, 50 | `d` | `dir` | the directory being walked |
| 48–50 | `e`, `r` | `entry`, `relPath` | a dirent; its path relative to the skill |
| 63 | `mk` | `made` | the mkdir result |
| 122 | `e` | `error` | C1 |
| 174, 188, 211 | `r` | `replaced`, `removed`, `removed` | the fuzzy-replace result; rm results |

## phantom-backend/systemSkills.ts

| line | old | new | what it is |
|---|---|---|---|
| 43, 52 | `e` | `error` | C1 |
| 69 | `a`, `b` | keep | C5 |
| 93 | `ex` | `extractor` | the tar extract stream |
| 104 | `d` | `chunk` | a tar entry data chunk |
| 107 | `s` | `skill` | the skill being assembled from the tar |

## phantom-backend/web.ts

| line | old | new | what it is |
|---|---|---|---|
| 31, 56, 104 | `r` | `response`, `result`, `result` | the fetch Response; Firecrawl's JSON |
| 43 | `s` | `slug` | the URL turned into a filename |
| 63 | `x` | `body` | a Firecrawl response body |
| 66, 113 | `e` | `error` | C1 |
| 80 | `n` | `suffix` | the number appended to a taken filename |
| 102 | `b` | `body` | the search request body |
| 138 | `u` | `url` | one URL to fetch |

## phantom-backend/models.ts

| line | old | new | what it is |
|---|---|---|---|
| 36, 70, 106, 141 | `p` | `provider` | a provider name |
| 78 | `a`, `b` | keep | C5 |
| 85, 93, 116 | `f` | `fetchFn` | the injectable fetch |
| 155 | `m` | `model` | a catalog model |

## phantom-backend/agentConfig.ts

| line | old | new | what it is |
|---|---|---|---|
| 56, 103 | `v` | `value` | a setting value |
| 127 | `r` | `resolved` | the resolved model |
| 136 | `i` | `input` | the config input |

## phantom-backend/sessionTitle.ts

| line | old | new | what it is |
|---|---|---|---|
| 34 | `s`, `n` | `text`, `max` | the text; the cap |
| 36 | `p` | `part` | a message content part |
| 52–78 | `m` | `message` | a user message |
| 67, 70 | `i` | `index` | its position in the list |
| 88 | `t` | `title` | the title being cleaned |
| 102, 142, 149 | `e` | `error` | C1 |
| 126 | `s` | `session` | the session row |

## phantom-backend/crypto.ts

| line | old | new | what it is |
|---|---|---|---|
| 8–11 | `a`, `b`, `ab`, `bb` | `left`, `right`, `leftBytes`, `rightBytes` | the two strings compared; their bytes |
| 15, 22 | `iv` | keep | the standard name of an initialization vector |
| 17, 24 | `ct` | `ciphertext` | |

## phantom-backend/env.ts — 25–26 `k`, `v` → `name`, `value` (an env var).
## phantom-backend/docker.ts — 10 `p` → `socketPath`.
## phantom-backend/log.ts — 10 `e` → `error`.

## phantom-backend/tokenReport.ts

| line | old | new | what it is |
|---|---|---|---|
| 17, 23 | `n` | `days`, `count` | days back; a token count |
| 23 | `k` | `short` | the thousands/millions formatter |
| 28, 41 | `t` | `totals` | a window's totals |
| 33, 47–57 | `r` | `row` | a report row |
| 35, 51, 56 | `a`, `b` | `sum`, `next` / keep | the running sum and the next totals; C5 at 55 |
| 50 | `h` | `heading` | a column heading |
