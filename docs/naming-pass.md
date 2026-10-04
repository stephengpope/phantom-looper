# Naming pass — variables

Objects and public functions were reviewed in the object pass. This is what is left: every one- and two-letter local or parameter, by file, with a proposed name read off the line (`?` = needs a human read). Kept without a row: `i j` (indexes), `a b` (comparators), `id by at on ok db tx ms dm`.

1570 sites in 183 files.

## phantom-cli/window.ts — 105

| line | old | new | the line |
|---|---|---|---|
| 257 | `o` | `overlay` | `showOverlay(o: Overlay): void {` |
| 285 | `d` | `dialog` | `showDialog(d: Dialog): void {` |
| 347 | `e` | `error` | `const e = this.sessions.get(session);` |
| 358 | `e` | `error` | `const e = this.sessions.active();` |
| 366 | `e` | `error` | `const e = this.sessions.active();` |
| 461 | `l` | `line` | `private notify(): void { for (const l of [...this.listeners]) l(); }` |
| 498 | `e` | `error` | `const e = at();` |
| 501 | `r` | `apiResult` | `const r = await this.api('GET', `/sessions/${e.id}`) as { planMode?: boolean };` |
| 513 | `e` | `error` | `const e = at();` |
| 522 | `e` | `error` | `const e = at();` |
| 538 | `e` | `error` | `const e = at();` |
| 560 | `e` | `error` | `const e = this.sessions.get(id);` |
| 577 | `n` | `count` | `return { tools, mutating: Object.keys(tools).filter((n) => /create\|update\|move\|block\|enter` |
| 587 | `st` | `apiResult` | `const st = await this.api('GET', `/settings?project=${encodeURIComponent(projectId)}`) as ` |
| 589 | `e` | `error` | `} catch (e) { quiet('read the reasoning setting')(e); }` |
| 596 | `s` | `sessionStore` | `const s: SessionStore = new SessionStore(() => {` |
| 606 | `e` | `error` | `else { const e = this.sessions.get(id); if (e) e.draft = text; }` |
| 624 | `r` | `apiResult` | `const r = await this.api('GET', `/sessions/${id}`) as {` |
| 630 | `e` | `error` | `} catch (e) { quiet(`re-read session ${id}`)(e); }` |
| 641 | `e` | `error` | `for (const e of this.sessions.list()) await this.recheckSession(e.id);` |
| 657 | `t` | `apiResult` | `const t = await this.api('GET', `/sessions/${id}/transcript`) as` |
| 698 | `p` | `project` | `for (const p of paths) {` |
| 701 | `r` | `apiResult` | `const r = await this.api('POST', `/sessions/${session.id}/attachments`,` |
| 707 | `e` | `error` | `} catch (e) {` |
| 723 | `e` | `error` | `const e = this.sessions.get(id);` |
| 775 | `e` | `error` | `} catch (e) {` |
| 789 | `e` | `error` | `const e = this.sessions.active();` |
| 826 | `e` | `error` | `onError: (e) => forEntry()?.onError(e),` |
| 827 | `n` | `count` | `onNotice: (n) => forEntry()?.onNotice(n),` |
| 878 | `e` | `error` | `} catch (e) {` |
| 899 | `s` | `session` | `const row = this.picker?.sessions.find((s) => s.id === id);` |
| 914 | `e` | `loadedSession` | `private labelOf(e: LoadedSession): string { return e.name ?? e.card ?? e.branch; }` |
| 928 | `e` | `error` | `const e = this.sessions.get(target);` |
| 1045 | `e` | `loadedSession` | `private matchesPickerQuery(e: LoadedSession): boolean {` |
| 1046 | `q` | `query` | `const q = this.pickerQuery.trim().toLowerCase();` |
| 1058 | `e` | `error` | `const local = new Map(this.sessions.list().map((e) => [e.id, e]));` |
| 1059 | `s` | `session` | `const enriched = rows.map((s) => {` |
| 1060 | `e` | `error` | `const e = local.get(s.id);` |
| 1069 | `s` | `session` | `const seen = new Set(rows.map((s) => s.id));` |
| 1071 | `e` | `error` | `.filter((e) => !seen.has(e.id) && (e.lastMessageAt > 0 \|\| e.pinned) && this.matchesPickerQ` |
| 1072 | `e` | `error` | `.map((e) => ({` |
| 1119 | `p` | `project` | `const p = this.picker;` |
| 1120 | `r` | `result` | `const tail = [...(p?.sessions ?? [])].reverse().find((r) => r.lastUserMessage !== null);` |
| 1130 | `s` | `session` | `const seen = new Set(prev.sessions.map((s) => s.id));` |
| 1131 | `s` | `session` | `const rows = [...prev.sessions, ...got.sessions.filter((s) => !seen.has(s.id))];` |
| 1133 | `r` | `row` | `...this.withOpenHere(rows.filter((r) => r.lastUserMessage !== null), got.total),` |
| 1137 | `e` | `error` | `} catch (e) { quiet('load more sessions')(e); }` |
| 1150 | `e` | `error` | `} catch (e) {` |
| 1167 | `s` | `session` | `const row = this.picker?.sessions.find((s) => s.id === id);` |
| 1173 | `e` | `error` | `} catch (e) {` |
| 1186 | `e` | `error` | `} catch (e) {` |
| 1214 | `r` | `closeSessionResult` | `const r = await this.closeSession(id);` |
| 1233 | `e` | `error` | `} catch (e) {` |
| 1234 | `m` | `message` | `const m = (e as Error).message;` |
| 1257 | `r` | `closeSessionResult` | `const r = await this.closeSession(id, true);` |
| 1262 | `e` | `error` | `catch (e) { say.refuse(`could not trash session ${id}: ${(e as Error).message}`); return; ` |
| 1270 | `r` | `row` | `const row = this.picker?.sessions.find((r) => r.id === id);` |
| 1272 | `t` | `target` | `refuse: (t) => { this.pickerNotice = t; this.notify(); },` |
| 1282 | `e` | `loadedSession` | `private trashActive = (e: LoadedSession): Promise<void> =>` |
| 1292 | `e` | `error` | `catch (e) { this.note(`could not list projects: ${(e as Error).message}`); }` |
| 1321 | `n` | `count` | `const hits = this.projectRows.filter((project) => names(project).some((n) => n?.toLowerCas` |
| 1339 | `x` | `?` | `const project = this.projectRows.find((x) => x.id === id);` |
| 1362 | `e` | `error` | `} catch (e) {` |
| 1378 | `r` | `apiResult` | `const r = await this.api('GET', `/sessions/${id}/tasks`) as unknown as TasksView;` |
| 1404 | `e` | `error` | `} catch (e) { this.note(`could not list tasks: ${(e as Error).message}`); }` |
| 1434 | `e` | `error` | `const e = store.get(id);` |
| 1442 | `e` | `error` | `const e = store.get(id);` |
| 1467 | `e` | `error` | `} catch (e) {` |
| 1481 | `d` | `apiResult` | `const d = await this.api('GET',` |
| 1488 | `e` | `error` | `} catch (e) { this.note(`could not list archived cards: ${(e as Error).message}`); }` |
| 1497 | `d` | `apiResult` | `const d = await this.api('GET', `/projects/${projectId}/cards?archived=only&limit=${PICKER` |
| 1501 | `t` | `target` | `const seen = new Set(this.archived.map((t) => t.id));` |
| 1502 | `t` | `target` | `this.archived = [...this.archived, ...d.cards.filter((t) => !seen.has(t.id))];` |
| 1504 | `e` | `error` | `} catch (e) { quiet('load more archived cards')(e); }` |
| 1514 | `x` | `?` | `this.archived = this.archived.filter((x) => x.id !== card.id);` |
| 1517 | `e` | `error` | `} catch (e) { this.archivedNotice = `restore failed: ${(e as Error).message}`; }` |
| 1545 | `r` | `autoPushResult` | `const r = await this.opts.autoPush(id, (label) => say(`auto-push: ${label}`));` |
| 1550 | `e` | `error` | `} catch (e) {` |
| 1565 | `r` | `autoPullResult` | `const r = await this.opts.autoPull(id, (label) => say(`auto-pull: ${label}`));` |
| 1573 | `e` | `error` | `} catch (e) {` |
| 1605 | `e` | `error` | `} catch (e) { this.note(`assistant not started: ${(e as Error).message}`); return; }` |
| 1635 | `e` | `error` | `} catch (e) {` |
| 1644 | `c` | `readSettingsResult` | `const c = await this.readSettings();` |
| 1668 | `e` | `error` | `catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }` |
| 1731 | `e` | `error` | `catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }` |
| 1734 | `e` | `error` | `catch (e) { this.note(`could not save ${key}: ${(e as Error).message}`); return; }` |
| 1773 | `r` | `closeSessionResult` | `const r = await this.closeSession();` |
| 1809 | `e` | `error` | `} catch (e) { this.note(`could not rename session ${session.id}: ${(e as Error).message}`)` |
| 1818 | `e` | `error` | `} catch (e) { this.note(`could not pin session ${session.id}: ${(e as Error).message}`); }` |
| 1833 | `e` | `error` | `catch (e) { this.note(`could not unpin session ${session.id}: ${(e as Error).message}`); r` |
| 1835 | `r` | `closeSessionResult` | `const r = await this.closeSession();` |
| 1851 | `e` | `error` | `} catch (e) { this.note(`could not enter plan mode: ${(e as Error).message}`); }` |
| 1860 | `e` | `error` | `} catch (e) { this.note(`could not enter code mode: ${(e as Error).message}`); }` |
| 1888 | `r` | `apiResult` | `const r = await this.api('GET', '/system/status') as { text?: string; warnings?: string };` |
| 1890 | `e` | `error` | `} catch (e) { this.note(`could not read the server status: ${(e as Error).message}`); }` |
| 1895 | `r` | `apiResult` | `const r = await this.api('GET', '/system/token-usage') as { text?: string };` |
| 1897 | `e` | `error` | `} catch (e) { this.note(`could not read token usage: ${(e as Error).message}`); }` |
| 1910 | `e` | `error` | `} catch (e) { this.note(`could not restart: ${(e as Error).message}`); }` |
| 1931 | `e` | `error` | `const all = session.agent.userMessages.pending().map((e) => e.text).filter(Boolean).join('` |
| 1941 | `c` | `char` | `this.note(COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.summary}`).join('\n'));` |
| 1971 | `n` | `count` | `const gone = expanded.missing.map((n) => `#${n}`).join(', ');` |
| 2049 | `e` | `error` | `} catch (e) {` |
| 2075 | `ss` | `?` | `const ss = ((await this.api('GET', '/sessions')) as unknown as { sessions: SessionInfo[] }` |
| 2078 | `e` | `error` | `} catch (e) { this.note(`could not reopen your last project: ${(e as Error).message}`); }` |
| 2107 | `f` | `file` | `for (const f of this.feeds.values()) f.stop();` |

## phantom-cli/components/CardEditor.tsx — 49

| line | old | new | the line |
|---|---|---|---|
| 73 | `r` | `row` | `const prose = (r: Row) => r.kind === 'item' \|\| (r.kind === 'field' && r.field !== 'title')` |
| 85 | `r` | `row` | `const rowKey = (r: Row) =>` |
| 97 | `d` | `draft` | `function buildRows(d: Draft, status: string): Row[] {` |
| 100 | `n` | `count` | `const n = d[list].length;` |
| 116 | `t` | `card` | `const toDraft = (t: Card): Draft => ({` |
| 120 | `c` | `char` | `requirements: t.requirements.map((c) => ({ ...c })),` |
| 128 | `d` | `draft` | `function diffPatch(d: Draft, c: Card): CardPatch {` |
| 128 | `c` | `card` | `function diffPatch(d: Draft, c: Card): CardPatch {` |
| 143 | `s` | `cardStep` | `const canon = (s: CardStep): CardStep => ({ key: s.key, text: s.text.trim(), done: s.done ` |
| 144 | `v` | `value` | `const v = d.requirements.map(canon).filter((s) => s.text);` |
| 144 | `s` | `session` | `const v = d.requirements.map(canon).filter((s) => s.text);` |
| 179 | `d` | `data` | `setDraft((d) => {` |
| 181 | `k` | `key` | `for (const k of Object.keys(next) as (keyof Draft)[])` |
| 227 | `r` | `row` | `const place = (r: Row) => {` |
| 228 | `n` | `count` | `const n = rowRefs.current.get(rowKey(r));` |
| 230 | `m` | `message` | `const m = measureElement(n);` |
| 235 | `f` | `file` | `const f = followed.current !== at ? place(rowsNow[at]) : null;` |
| 243 | `r` | `row` | `for (const r of rowsNow) {` |
| 244 | `p` | `project` | `const p = place(r);` |
| 260 | `n` | `count` | `const setAt = (i: number) => { atRef.current = i; bump((n) => n + 1); };` |
| 262 | `n` | `count` | `const n = buildRows(draftRef.current, card.status).length;` |
| 282 | `dr` | `?` | `setDraft((dr) => ({ ...dr, [list]: fn(dr[list] as (string \| CardStep)[]) }));` |
| 291 | `x` | `?` | `const used = new Set(taken.map((x) => typeof x === 'string' ? '' : x.key));` |
| 297 | `v` | `value` | `setList(list, (v) => v.map((x, j) => j === index` |
| 297 | `x` | `?` | `setList(list, (v) => v.map((x, j) => j === index` |
| 300 | `v` | `value` | `setList(list, (v) => v.map((x, j) => j === index ? { ...(x as CardStep), done: !(x as Card` |
| 300 | `x` | `?` | `setList(list, (v) => v.map((x, j) => j === index ? { ...(x as CardStep), done: !(x as Card` |
| 302 | `v` | `value` | `setList(list, (v) => [...v.slice(0, index + 1), newItem(list, '', v), ...v.slice(index + 1` |
| 339 | `t` | `target` | `const server = store.state.cards.find((t) => t.id === id);` |
| 354 | `s` | `session` | `setSaveState((s) => s !== 'saving' ? s : failedRef.current === sent ? 'failed' : 'saved');` |
| 367 | `r` | `row` | `const r = rowsNow[Math.min(atRef.current, rowsNow.length - 1)];` |
| 369 | `ev` | `?` | `const ev = parseMouse(ch);` |
| 379 | `m` | `message` | `const m = measureElement(node);` |
| 383 | `d` | `data` | `if (hitRow.kind === 'archived') setDraft((d) => ({ ...d, archived: !d.archived }));` |
| 384 | `d` | `data` | `if (hitRow.kind === 'pinned') setDraft((d) => ({ ...d, pinned: !d.pinned }));` |
| 386 | `d` | `data` | `if (hitRow.kind === 'auto') setDraft((d) => ({ ...d, [hitRow.field]: cycleAuto(d[hitRow.fi` |
| 408 | `d` | `data` | `if (key.return \|\| ch === ' ') { setDraft((d) => ({ ...d, [r.field]: cycleAuto(d[r.field]) ` |
| 419 | `d` | `data` | `if (key.return \|\| ch === ' ') setDraft((d) => ({ ...d, pinned: !d.pinned }));` |
| 423 | `d` | `data` | `if (key.return \|\| ch === ' ') setDraft((d) => ({ ...d, archived: !d.archived }));` |
| 429 | `v` | `value` | `setList(r.list, (v) => v.filter((_, j) => j !== r.index));` |
| 435 | `r` | `row` | `const ref = (r: Row) => (n: DOMElement \| null) => { if (n) rowRefs.current.set(rowKey(r), ` |
| 435 | `n` | `dOMElement` | `const ref = (r: Row) => (n: DOMElement \| null) => { if (n) rowRefs.current.set(rowKey(r), ` |
| 467 | `v` | `value` | `: input(field, draft[field], (v) => setDraft((d) => ({ ...d, [field]: v })), next, placeho` |
| 467 | `d` | `data` | `: input(field, draft[field], (v) => setDraft((d) => ({ ...d, [field]: v })), next, placeho` |
| 503 | `v` | `value` | `onChange={(v) => { setList(list, () => [newItem(list, v)]); }}` |
| 506 | `c` | `card` | `) : tickable(list) ? <Text dimColor>{(items as CardStep[]).filter((c) => c.done).length}/{` |
| 508 | `v` | `value` | `{items.map((v, i) => {` |
| 509 | `k` | `key` | `const k = `${list}:${i}`;` |
| 520 | `t` | `target` | `: input(k, itemText(v), (t) => setItem(list, i, t), () => insertBelow(list, i), '', width ` |

## phantom-cli/sessions.ts — 45

| line | old | new | the line |
|---|---|---|---|
| 117 | `e` | `loadedSession` | `export const activeHold = (e: LoadedSession \| undefined \| null): LoadedSession['held'] =>` |
| 148 | `e` | `loadedSession` | `constructor(private onTurnEnd?: (e: LoadedSession) => void) {}` |
| 155 | `l` | `line` | `private notify(): void { for (const l of [...this.listeners]) l(); }` |
| 158 | `e` | `error` | `return this.entries.find((e) => e.id === id);` |
| 161 | `e` | `error` | `has(id: string): boolean { return this.entries.some((e) => e.id === id); }` |
| 169 | `ap` | `?` | `const ap = a.pinned && a.lastMessageAt > 0;` |
| 170 | `bp` | `?` | `const bp = b.pinned && b.lastMessageAt > 0;` |
| 178 | `s` | `newSession` | `add(s: NewSession): LoadedSession {` |
| 206 | `e` | `loadedSession` | `private wire(e: LoadedSession): () => void {` |
| 258 | `e` | `error` | `handlersFor(id: string): { onError(e: PhantomError): void; onNotice(n: { type: string; tex` |
| 261 | `e` | `error` | `const e = this.get(id);` |
| 281 | `n` | `count` | `onNotice: (n) => {` |
| 282 | `e` | `error` | `const e = this.get(id);` |
| 291 | `e` | `loadedSession` | `private userParts(e: LoadedSession, texts: string[]): void {` |
| 292 | `t` | `target` | `for (const t of texts) if (t.trim()) e.done = [...e.done, { kind: 'user', id: nextId('user` |
| 297 | `e` | `loadedSession` | `private turnSettled(e: LoadedSession): void {` |
| 321 | `d` | `dialog` | `setAsk(id: string, d: Dialog): void {` |
| 322 | `e` | `error` | `const e = this.get(id);` |
| 332 | `e` | `error` | `const e = this.get(id);` |
| 342 | `e` | `error` | `const e = this.get(id);` |
| 358 | `e` | `error` | `const e = this.get(id);` |
| 362 | `x` | `?` | `this.entries = this.entries.filter((x) => x.id !== id);` |
| 374 | `e` | `error` | `const e = this.get(id);` |
| 385 | `e` | `error` | `const at = order.findIndex((e) => e.id === this.activeId);` |
| 386 | `n` | `count` | `const n = order.length;` |
| 396 | `e` | `error` | `const e = this.get(id);` |
| 401 | `e` | `error` | `const e = this.get(id);` |
| 410 | `e` | `error` | `const e = this.get(id);` |
| 425 | `e` | `loadedSession` | `private repaint(e: LoadedSession, messages: readonly ModelMessage[]): void {` |
| 439 | `e` | `error` | `const e = this.get(id);` |
| 451 | `e` | `error` | `const e = this.get(id);` |
| 458 | `e` | `error` | `const e = this.get(id);` |
| 473 | `e` | `error` | `const e = this.get(id);` |
| 480 | `e` | `error` | `const e = this.get(id);` |
| 494 | `e` | `error` | `const e = this.get(id);` |
| 509 | `e` | `error` | `const e = this.get(id);` |
| 517 | `e` | `error` | `const e = this.get(id);` |
| 526 | `e` | `error` | `abortAll(): void { for (const e of this.entries) e.agent.interrupt(); }` |
| 531 | `e` | `error` | `return Promise.all(this.entries.map((e) => { e.unwire(); return e.agent.close(); })).then(` |
| 535 | `e` | `error` | `const e = this.get(id);` |
| 544 | `e` | `error` | `const e = this.get(id);` |
| 553 | `e` | `error` | `const e = this.get(id);` |
| 560 | `e` | `loadedSession` | `private fold(e: LoadedSession, parts: StreamPart[]): void {` |
| 561 | `t` | `target` | `let t = e.turn;` |
| 563 | `p` | `project` | `for (const p of parts) {` |

## phantom-cli/components/Presets.tsx — 44

| line | old | new | the line |
|---|---|---|---|
| 49 | `k` | `key` | `return groupBlocks(keys, (k) => k);` |
| 51 | `g` | `group` | `const allKeys = (groups: PresetGroup[]) => groups.flatMap((g) => g.items.map((k) => k.key)` |
| 51 | `k` | `key` | `const allKeys = (groups: PresetGroup[]) => groups.flatMap((g) => g.items.map((k) => k.key)` |
| 99 | `p` | `preset` | `function presetHint(p: Preset, groups: PresetGroup[]): string {` |
| 101 | `g` | `group` | `for (const g of groups) {` |
| 103 | `k` | `key` | `for (const k of g.items) {` |
| 104 | `s` | `session` | `const s = keyState(p.values, k.key);` |
| 142 | `r` | `result` | `.then((r) => setServerEntries(r))` |
| 153 | `r` | `result` | `const r = await api('GET', '/presets') as Preset[];` |
| 156 | `e` | `error` | `} catch (e) { setNotice(`could not load presets: ${(e as Error).message}`); setPresets([])` |
| 165 | `r` | `result` | `const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models` |
| 167 | `e` | `error` | `} catch (e) {` |
| 180 | `p` | `preset` | `const applyPreset = useCallback(async (p: Preset) => {` |
| 186 | `k` | `key` | `for (const k of keys) {` |
| 198 | `e` | `error` | `} catch (e) { setNotice(`could not apply: ${(e as Error).message}`); }` |
| 219 | `ps` | `?` | `setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));` |
| 219 | `p` | `project` | `setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));` |
| 222 | `e` | `error` | `} catch (e) { setNotice(`could not save: ${(e as Error).message}`); }` |
| 232 | `k` | `key` | `const values = Object.fromEntries(keys.map((k) => [k, null]));` |
| 238 | `e` | `error` | `} catch (e) { setNotice(`could not create: ${(e as Error).message}`); }` |
| 248 | `ps` | `?` | `setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));` |
| 248 | `p` | `project` | `setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));` |
| 251 | `e` | `error` | `} catch (e) { setNotice(`could not rename: ${(e as Error).message}`); }` |
| 262 | `e` | `error` | `} catch (e) { setNotice(`could not delete: ${(e as Error).message}`); }` |
| 270 | `n` | `count` | `onSubmit={(n) => { void createPreset(n); }}` |
| 280 | `n` | `count` | `onSubmit={(n) => { void renamePreset(view.preset, n); }}` |
| 292 | `v` | `value` | `onSubmit={(v) => {` |
| 303 | `p` | `project` | `const p = view.preset;` |
| 311 | `k` | `key` | `const choices = headedChoices(groups, (k) => {` |
| 313 | `v` | `value` | `const v = p.values[k.key];` |
| 333 | `k` | `key` | `onSelect={(k) => {` |
| 335 | `g` | `group` | `const info = groups.flatMap((g) => g.items).find((x) => x.key === k);` |
| 335 | `x` | `?` | `const info = groups.flatMap((g) => g.items).find((x) => x.key === k);` |
| 344 | `s` | `session` | `void finishSpec(k, spec, merged).then((s) =>` |
| 348 | `ch` | `channel` | `onKey={(ch, k) => {` |
| 348 | `k` | `key` | `onKey={(ch, k) => {` |
| 397 | `p` | `project` | `const p = presets.find((x) => x.id === id);` |
| 397 | `x` | `?` | `const p = presets.find((x) => x.id === id);` |
| 403 | `ch` | `channel` | `onKey={(ch, id) => {` |
| 406 | `p` | `project` | `const p = presets.find((x) => x.id === id);` |
| 406 | `x` | `?` | `const p = presets.find((x) => x.id === id);` |
| 433 | `v` | `value` | `onChange={(v) => { setText(v); onNotice(undefined); }}` |
| 434 | `v` | `value` | `onSubmit={(v) => {` |
| 435 | `n` | `count` | `const n = v.trim();` |

## phantom-cli/voice.ts — 41

| line | old | new | the line |
|---|---|---|---|
| 110 | `c` | `char` | `for (const c of candidates) if (existsSync(c)) return c;` |
| 111 | `r` | `result` | `const r = spawnSync('uv', ['--version'], { stdio: 'ignore' });` |
| 130 | `r` | `row` | `fetch(base).then(async (r) => { if (!r.ok) throw new Error(`uv download: HTTP ${r.status}`` |
| 131 | `r` | `row` | `fetch(`${base}.sha256`).then(async (r) => { if (!r.ok) throw new Error(`uv checksum: HTTP ` |
| 139 | `r` | `result` | `const r = spawnSync('tar', ['-xzf', tmp, '-C', dir, '--strip-components=1', `uv-${target}/` |
| 141 | `uv` | `?` | `const uv = join(dir, 'uv');` |
| 154 | `l` | `line` | `createInterface({ input: child.stdout! }).on('line', (l) => log(l));` |
| 155 | `l` | `line` | `createInterface({ input: child.stderr! }).on('line', (l) => log(l));` |
| 156 | `e` | `error` | `child.on('error', (e) => { log(`--- uv sync error ${e.message}`); resolve(null); });` |
| 163 | `uv` | `?` | `let uv = findUv();` |
| 177 | `l` | `line` | `createInterface({ input: child.stderr! }).on('line', (l) => log(l));` |
| 180 | `e` | `error` | `child.on('error', (e) => { exited = true; log(`--- sidecar error ${e.message}`); onExit(nu` |
| 199 | `uv` | `?` | `const uv = findUv();` |
| 206 | `e` | `error` | `child.on('error', (e) => { log(`could not list audio devices: ${e.message}`); resolve(none` |
| 209 | `l` | `line` | `const line = out.split('\n').find((l) => l.trim().startsWith('{'));` |
| 210 | `d` | `data` | `const d = line ? JSON.parse(line) as { mics?: unknown; speakers?: unknown } : {};` |
| 212 | `e` | `error` | `} catch (e) { log(`could not read the audio device list: ${(e as Error).message}`); resolv` |
| 223 | `s` | `session` | `const s = (v: ConfigValue) => (v === null \|\| v === undefined ? '' : String(v));` |
| 223 | `v` | `configValue` | `const s = (v: ConfigValue) => (v === null \|\| v === undefined ? '' : String(v));` |
| 294 | `m` | `modelMessage` | `export function truncateAssistant(m: ModelMessage, spoken: string): ModelMessage {` |
| 297 | `c` | `char` | `const rest = m.content.filter((c) => c.type !== 'text');` |
| 298 | `c` | `char` | `const at = m.content.findIndex((c) => c.type === 'text');` |
| 315 | `m` | `message` | `for (const m of messages) {` |
| 320 | `c` | `char` | `: m.content.filter((c) => c.type === 'text').map((c) => (c as { type: 'text'; text: string` |
| 320 | `c` | `char` | `: m.content.filter((c) => c.type === 'text').map((c) => (c as { type: 'text'; text: string` |
| 378 | `fn` | `?` | `for (const fn of this.subs) fn();` |
| 393 | `t` | `turn` | `const t: Turn = { id: `vt${++this.turnSeq}`, step: 0 };` |
| 396 | `k` | `key` | `for (const k of [...this.turns.keys()].slice(0, -8)) this.turns.delete(k);   // keep the r` |
| 402 | `t` | `target` | `const t = this.cur;` |
| 421 | `e` | `error` | `handlers(): { onError(e: PhantomError): void; onNotice(n: { type: string; text: string }):` |
| 423 | `e` | `error` | `onError: (e) => {` |
| 428 | `n` | `count` | `onNotice: (n) => { if (n.type !== 'retry') this.note({ kind: 'note', id: nextId('vnote'), ` |
| 464 | `e` | `error` | `} catch (e) {` |
| 514 | `p` | `part` | `private note(p: Part): void { this.set({ done: [...this.snap.done, p] }); }` |
| 538 | `t` | `turn` | `private onPart(t: Turn, part: StreamPart): void {` |
| 562 | `m` | `extract` | `private onSpoken(m: Extract<VoiceIn, { type: 'spoken' }>): void {` |
| 564 | `t` | `target` | `const t = this.turns.get(m.turn);` |
| 568 | `ps` | `part` | `const trim = (ps: Part[]) => {` |
| 569 | `p` | `project` | `const last = [...ps].reverse().find((p) => p.kind === 'text');` |
| 570 | `p` | `project` | `return ps.map((p) => (p === last ? { ...p, text: m.text } : p));` |
| 613 | `p` | `project` | `const p = this.partial ?? { id: nextId('vpart'), heard: '', interim: '' };` |

## phantom-backend/telegram/commands.ts — 38

| line | old | new | the line |
|---|---|---|---|
| 115 | `r` | `switchSessionResult` | `const r = await telegram.switchSession(client, dm, id, { silent: true });` |
| 133 | `r` | `switchSessionResult` | `const r = await telegram.switchSession(client, dm, id);` |
| 141 | `s` | `session` | `const pinned = allSessions.filter((s) => s.pinned);` |
| 142 | `s` | `session` | `const nonPinned = allSessions.filter((s) => !s.pinned);` |
| 145 | `s` | `session` | `sessionList.set(dm, sessions.map((s) => s.id));` |
| 147 | `s` | `session` | `const rows = sessions.map((s, i) =>` |
| 160 | `n` | `count` | `const n = Number.parseInt(arg, 10);` |
| 165 | `x` | `?` | `const project = list.find((x) => x.id === ids[n - 1]);` |
| 181 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't start a session: ${(e as Error).message}`); return; }` |
| 195 | `s` | `session` | `const s = await sessionRow(telegram, bot.activeSessionId);` |
| 208 | `s` | `session` | `const s = bot.activeSessionId ? await sessionRow(telegram, bot.activeSessionId) : null;` |
| 246 | `s` | `session` | `const s = await sessionRow(telegram, bot.activeSessionId);` |
| 262 | `r` | `result` | `const r = pull` |
| 275 | `p` | `project` | `const p = listed(providerList, dm, arg);` |
| 278 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't switch provider: ${(e as Error).message}`); return; }` |
| 290 | `p` | `project` | `for (const p of PROVIDERS) {` |
| 301 | `p` | `project` | `const rows = keyed.map((p, i) => {` |
| 302 | `d` | `data` | `const d = telegram.backend.modelCatalog.latestFor(p);` |
| 327 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't switch model: ${(e as Error).message}`); return; }` |
| 331 | `m` | `message` | `modelList.set(dm, models.map((m) => m.id));` |
| 332 | `m` | `message` | `const rows = models.map((m, i) => `${i + 1}. ${m.id}${m.id === model ? ' (current)' : ''}`` |
| 348 | `p` | `project` | `const p = list.find((x) => x.id === id)!;` |
| 348 | `x` | `?` | `const p = list.find((x) => x.id === id)!;` |
| 350 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't apply "${p.name}": ${(e as Error).message}`); return;` |
| 357 | `p` | `project` | `presetList.set(dm, list.map((p) => p.id));` |
| 358 | `p` | `project` | `const rows = list.map((p, i) => `${i + 1}. ${p.name}${presetSummary(p.values)}`);` |
| 373 | `s` | `session` | `const locked = (await telegram.backend.sessions.list({ typed: true, background: false, lim` |
| 376 | `s` | `session` | `for (const s of locked) {` |
| 381 | `n` | `count` | `await reply(`🛑 Stopped ${names.length}: ${names.map((n) => `'${n}'`).join(', ')}.`);` |
| 389 | `s` | `session` | `const s = await sessionRow(telegram, id);` |
| 411 | `s` | `session` | `const s = await sessionRow(telegram, bot.activeSessionId);` |
| 428 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't read the server status: ${(e as Error).message}`); re` |
| 436 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't read token usage: ${(e as Error).message}`); return; ` |
| 454 | `e` | `error` | `catch (e) { await reply(`⚠️ Couldn't restart: ${(e as Error).message}`); return; }` |
| 473 | `m` | `sendMessageResult` | `const m = await client.sendMessage(dm, title).catch(() => null);` |
| 501 | `n` | `count` | `const n = r.arrived?.length ?? 0;` |
| 518 | `n` | `count` | `const n = Number.parseInt(arg, 10);` |
| 541 | `s` | `getResult` | `const s = await telegram.backend.sessions.get(id);` |

## packages/phantom-backend-sdk/src/api/routes/sessions.ts — 34

| line | old | new | the line |
|---|---|---|---|
| 28 | `s` | `sessionRow` | `function lockEvent(s: SessionRow, over: Partial<{ locked: boolean; by: string \| null; labe` |
| 64 | `h` | `header` | `const h = req.headers['x-phantom-looper-client'];` |
| 71 | `h` | `header` | `const h = req.headers['x-phantom-looper-actor'];` |
| 75 | `s` | `sessionRow` | `export const lockedErr = (s: SessionRow) =>` |
| 94 | `s` | `sessionRow` | `async function releaseHold(ctx: PhantomBackend, s: SessionRow, client: string): Promise<bo` |
| 150 | `e` | `error` | `} catch (e) {` |
| 205 | `r` | `listResult` | `const r = await ctx.sessions.list({` |
| 216 | `r` | `row` | `return ok({ total, sessions: rows.map((r) => ({ ...r, locked: isHeld(r, now) })) });` |
| 241 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 291 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 297 | `e` | `error` | `} catch (e) {` |
| 317 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 348 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 354 | `r` | `result` | `let r: { lines: number; applied: boolean; stamp: Date };` |
| 357 | `e` | `error` | `} catch (e) {` |
| 374 | `e` | `error` | `const unsubscribe = ctx.sessionEvents.subscribeAll((id, e) => {` |
| 415 | `e` | `error` | `const unsubscribe = ctx.sessionEvents.subscribe(req.params.id, (e, by) => {` |
| 427 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 439 | `e` | `error` | `for (const e of pending) write(e);` |
| 470 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 477 | `e` | `event` | `for (const e of req.body.events) {` |
| 557 | `e` | `error` | `} catch (e) {` |
| 574 | `r` | `pushResult` | `const r = await ctx.git.sync.push(src, project!);` |
| 592 | `e` | `error` | `} catch (e) {` |
| 611 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 640 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 655 | `e` | `error` | `catch (e) {` |
| 678 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 687 | `e` | `error` | `await ctx.git.sync.push(s, project).catch((e: Error) => {` |
| 696 | `e` | `error` | `await ctx.sessionContainers.remove(s.id).catch((e: Error) => {` |
| 704 | `e` | `error` | `} catch (e) {` |
| 731 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |
| 770 | `e` | `error` | `catch (e) { return reply.code(400).send(err('config_invalid', (e as Error).message)); }` |
| 789 | `s` | `session` | `const s = await ctx.sessions.get(req.params.id);` |

## phantom-cli/components/Board.tsx — 32

| line | old | new | the line |
|---|---|---|---|
| 43 | `n` | `count` | `useEffect(() => store.subscribe(() => bump((n) => n + 1)), [store]);` |
| 48 | `t` | `target` | `const t = setInterval(() => bump((n) => n + 1), TURN_AGE_TICK_MS);` |
| 48 | `n` | `count` | `const t = setInterval(() => bump((n) => n + 1), TURN_AGE_TICK_MS);` |
| 77 | `m` | `message` | `const m = measureElement(node);` |
| 84 | `t` | `card` | `const openEdit = (t: Card) => onOpenCard(t.number);` |
| 95 | `ci` | `?` | `const ci = columns.indexOf(req.column);` |
| 98 | `f` | `file` | `setFocus((f) => ({ col: ci, row: clampRow(ci, f.row) }));` |
| 114 | `ev` | `?` | `const ev = parseMouse(ch);` |
| 117 | `h` | `header` | `const h = hit(ev.x, ev.y);` |
| 120 | `ci` | `?` | `const ci = columns.indexOf(h.col);` |
| 126 | `h` | `header` | `const h = hit(ev.x, ev.y);` |
| 133 | `t` | `target` | `const clicked = store.state.cards.find((t) => t.id === drag.cardId);` |
| 138 | `f` | `file` | `setFocus((f) => ({ ...f, row: Math.max(0, Math.min(focusCards.length - 1, f.row + ev.butto` |
| 149 | `f` | `file` | `if (key.leftArrow) setFocus((f) => { const c = Math.max(0, f.col - 1); return { col: c, ro` |
| 149 | `c` | `char` | `if (key.leftArrow) setFocus((f) => { const c = Math.max(0, f.col - 1); return { col: c, ro` |
| 150 | `f` | `file` | `else if (key.rightArrow) setFocus((f) => { const c = Math.min(columns.length - 1, f.col + ` |
| 150 | `c` | `char` | `else if (key.rightArrow) setFocus((f) => { const c = Math.min(columns.length - 1, f.col + ` |
| 151 | `f` | `file` | `else if (key.downArrow) setFocus((f) => ({ ...f, row: clampRow(f.col, f.row + 1) }));` |
| 152 | `f` | `file` | `else if (key.upArrow) setFocus((f) => ({ ...f, row: clampRow(f.col, f.row - 1) }));` |
| 158 | `f` | `file` | `else if (key.tab && key.shift && focusCard && focus.col > 0) { const col = columns[focus.c` |
| 159 | `f` | `file` | `else if (key.tab && !key.shift && focusCard && focus.col < columns.length - 1) { const col` |
| 160 | `f` | `file` | `else if ((ch === 'j' \|\| ch === 'J') && focusCard) { void store.move(focusCard.id, focusCol` |
| 161 | `f` | `file` | `else if ((ch === 'k' \|\| ch === 'K') && focusCard && focus.row > 0) { void store.move(focus` |
| 166 | `t` | `target` | `const t = focusCard;` |
| 170 | `f` | `file` | `setFocus((f) => ({ ...f, row: clampRow(f.col, f.row) }));` |
| 173 | `z` | `?` | `else if (ch === 'e' && focusColName) setZoom((z) => !z);` |
| 177 | `t` | `target` | `const dragging = drag?.moved ? store.state.cards.find((t) => t.id === drag.cardId) : undef` |
| 196 | `t` | `target` | `const cards = store.state.cards.filter((t) => !t.archived).length;` |
| 205 | `ci` | `?` | `const ci = columns.indexOf(col);` |
| 209 | `n` | `count` | `<Box key={col} ref={(n) => { if (n) colRefs.current.set(col, n); }}` |
| 220 | `t` | `target` | `{cards.map((t, ri) => {` |
| 220 | `ri` | `?` | `{cards.map((t, ri) => {` |

## phantom-cli/state.ts — 31

| line | old | new | the line |
|---|---|---|---|
| 42 | `p` | `part` | `function isDone(p: Part): boolean {` |
| 61 | `p` | `project` | `turn.findIndex((p) => p.kind === kind && (p as { sid?: string }).sid === sid && !isDone(p)` |
| 63 | `p` | `project` | `turn.findIndex((p) => p.kind === kind && p.id === id && !isDone(p));` |
| 64 | `p` | `part` | `const replace = (i: number, p: Part) => [...turn.slice(0, i), p, ...turn.slice(i + 1)];` |
| 72 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'text' }>;` |
| 78 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'text' }>;` |
| 88 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'reasoning' }>;` |
| 94 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'reasoning' }>;` |
| 105 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'tool' }>;` |
| 119 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'tool' }>;` |
| 133 | `p` | `project` | `const p = turn[i] as Extract<Part, { kind: 'tool' }>;` |
| 152 | `nl` | `?` | `const nl = text.lastIndexOf('\n');` |
| 170 | `f` | `file` | `const f = /^\s{0,3}(```+\|~~~+)/.exec(line);` |
| 228 | `p` | `project` | `return turn.map((p) => {` |
| 235 | `p` | `project` | `}).filter((p) => !(p.kind === 'text' && !p.text.trim()));` |
| 242 | `p` | `project` | `const p = live[i];` |
| 269 | `t` | `turnTokens` | `export function applyTokens(t: TurnTokens, part: StreamPart): TurnTokens {` |
| 289 | `t` | `turnTokens` | `export const tokenCount = (t: TurnTokens): number => t.settled + Math.ceil(t.pendingChars ` |
| 294 | `k` | `key` | `const k = n / 1000;` |
| 296 | `m` | `message` | `const m = k / 1000;` |
| 323 | `s` | `session` | `const s = Math.max(0, Math.floor(ms / 1000));` |
| 331 | `d` | `data` | `const d = new Date(at);` |
| 332 | `h` | `header` | `const h = d.getHours() % 12 \|\| 12;` |
| 353 | `c` | `char` | `.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');` |
| 353 | `c` | `char` | `.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');` |
| 355 | `m` | `message` | `for (const m of messages) {` |
| 364 | `c` | `char` | `for (const c of content as { type: string; [k: string]: unknown }[]) {` |
| 378 | `c` | `char` | `for (const c of m.content) {` |
| 382 | `p` | `project` | `const p = parts[i] as Extract<Part, { kind: 'tool' }>;` |
| 389 | `p` | `project` | `return parts.map((p) =>` |
| 400 | `v` | `value` | `const v = output.value as { message?: string } \| string;` |

## phantom-cli/board.ts — 29

| line | old | new | the line |
|---|---|---|---|
| 90 | `t` | `target` | `if (!this.state.cards.some((t) => t.id === id)) return;` |
| 91 | `t` | `target` | `this.state = { ...this.state, cards: this.state.cards.filter((t) => t.id !== id) };` |
| 122 | `l` | `line` | `private notify(): void { for (const l of [...this.listeners]) l(); }` |
| 127 | `t` | `target` | `return this.state.cards.filter((t) => t.status === status && !t.archived)` |
| 131 | `t` | `target` | `byNumber(number: number): Card \| undefined { return this.state.cards.find((t) => t.number ` |
| 134 | `t` | `target` | `private numberOf(id: number): number \| undefined { return this.state.cards.find((t) => t.i` |
| 142 | `d` | `apiResult` | `const d = await this.api('GET', `/projects/${this.projectId}/cards?number=${number}`) as R` |
| 146 | `t` | `target` | `return this.state.cards.find((t) => t.id === card.id);` |
| 153 | `t` | `target` | `this.state = { ...this.state, cards: [...this.state.cards.filter((t) => t.id !== fresh.id)` |
| 174 | `d` | `apiResult` | `const d = await this.api('GET', `/projects/${this.projectId}/cards`) as Record<string, unk` |
| 176 | `s` | `session` | `for (const s of (d.card_sessions as { card: number; id: string; name: string \| null }[] \| ` |
| 184 | `t` | `target` | `const kept = this.state.cards.filter((t) => t.archived && !fresh.some((f) => f.id === t.id` |
| 184 | `f` | `file` | `const kept = this.state.cards.filter((t) => t.archived && !fresh.some((f) => f.id === t.id` |
| 200 | `e` | `error` | `} catch (e) {` |
| 212 | `d` | `apiResult` | `const d = await this.api('POST', `/projects/${this.projectId}/cards`, fields) as Record<st` |
| 225 | `t` | `target` | `this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === id ? { ...t, ...` |
| 228 | `d` | `apiResult` | `const d = await this.api('PATCH', `/projects/${this.projectId}/cards/${number}`, patch) as` |
| 232 | `e` | `error` | `catch (e) {` |
| 247 | `t` | `target` | `this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === fresh.id ? fresh` |
| 261 | `t` | `card` | `const apply = (t: Card): Card => {` |
| 263 | `o` | `options` | `for (const o of ops) {` |
| 264 | `e` | `cardStep` | `const hit = (e: CardStep) => e.key !== undefined && o.key !== undefined` |
| 267 | `e` | `error` | `else if (o.op === 'remove') next.requirements = next.requirements.filter((e) => !hit(e));` |
| 268 | `e` | `error` | `else next.requirements = next.requirements.map((e) => !hit(e) ? e` |
| 273 | `t` | `target` | `this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === id ? apply(t) : ` |
| 276 | `d` | `apiResult` | `const d = await this.api('PATCH', `/projects/${this.projectId}/cards/${number}`, { items: ` |
| 280 | `e` | `error` | `catch (e) {` |
| 291 | `d` | `apiResult` | `const d = await this.api('GET', `/projects/${this.projectId}/cards/${number}/revisions` +` |
| 298 | `t` | `target` | `const col = this.cardsIn(status).filter((t) => t.id !== id);` |

## packages/phantom-backend-sdk/src/storage/Sessions.ts — 26

| line | old | new | the line |
|---|---|---|---|
| 107 | `s` | `sessionRow` | `export const conversationOnly = (s: SessionRow): boolean => !ownsWorkspace(s);` |
| 114 | `s` | `sessionRow` | `export function assertDuplicable(s: SessionRow): void {` |
| 134 | `s` | `pick` | `export function workspaceOf(s: Pick<SessionRow, 'id' \| 'workspaceId'>): string {` |
| 143 | `l` | `line` | `export const lineCount = (jsonl: string): number => jsonl.split('\n').filter((l) => l.trim` |
| 147 | `s` | `pick` | `export const ownsWorkspace = (s: Pick<SessionRow, 'id' \| 'workspaceId'>): boolean => s.wor` |
| 151 | `s` | `pick` | `export const isHeld = (s: Pick<SessionRow, 'lockedBy' \| 'lockExpiresAt'>, now = Date.now()` |
| 155 | `s` | `sessionRow` | `export const heldByOther = (s: SessionRow, client: string): boolean =>` |
| 162 | `s` | `pick` | `export function expiredHold(s: Pick<SessionRow, 'lockedBy' \| 'lockedLabel' \| 'lockExpiresA` |
| 207 | `s` | `createResult` | `const s = await this.create(projectId, opts);` |
| 214 | `s` | `sessionRow` | `private async writeSystemPrompt(s: SessionRow, layout: SystemPromptLayout): Promise<Stored` |
| 249 | `v` | `value` | `private static readonly lastUsedAt = sqlRaw<Date>`coalesce(${workspaces.lastUsedAt}, ${ses` |
| 273 | `m` | `modelForResult` | `const m = await this.agentConfig.modelFor(type, project ? { projectId: project.id } : {});` |
| 285 | `s` | `session` | `for (const s of rows) {` |
| 287 | `m` | `birthModelResult` | `const m = await this.birthModel(s.projectId, s.agent);` |
| 309 | `n` | `count` | `for (let n = 0; n < after; n++) {` |
| 310 | `nl` | `?` | `const nl = data.indexOf('\n', pos);` |
| 346 | `q` | `listQuery` | `async list(q: ListQuery): Promise<{ sessions: ListedSession[]; total: number }> {` |
| 360 | `c` | `char` | `const needle = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;` |
| 416 | `r` | `row` | `return new Set(rows.flatMap((r) => (r.workspaceId ? [r.workspaceId] : [])));` |
| 584 | `s` | `thi` | `const s = await this.get(id);` |
| 646 | `s` | `sessionRow` | `async appendTranscript(s: SessionRow, client: string, body: { after: number; deliveryId: s` |
| 648 | `l` | `line` | `const text = body.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';` |
| 683 | `r` | `row` | `const r = rows[0];` |
| 706 | `s` | `sessionRow` | `async turnEnded(s: SessionRow, actor: string): Promise<{` |
| 775 | `s` | `sessionRow` | `async touch(s: SessionRow): Promise<void> {` |
| 793 | `s` | `sessionRow` | `async acquireLock(s: SessionRow, client: string, ttlMs: number, label?: string): Promise<D` |

## packages/phantom-backend-sdk/src/api/routes/fs.ts — 25

| line | old | new | the line |
|---|---|---|---|
| 45 | `e` | `error` | `.catch((e) => log.warn({ err: errStr(e) }, 'kill of command group failed'));` |
| 66 | `l` | `line` | `const lines = out.split('\n').filter((l) => l.trim() !== '');` |
| 68 | `t` | `target` | `const titles = lines[0].trim().split(/\s+/).map((t) => t.toUpperCase());` |
| 78 | `m` | `message` | `const m = line.trim().split(/\s+/);` |
| 98 | `m` | `match` | `const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());` |
| 111 | `r` | `row` | `for (const r of rows) {` |
| 113 | `g` | `group` | `const g = bySid.get(r.sid);` |
| 118 | `r` | `result` | `const leader = g.find((r) => r.pid === r.sid) ?? g[0];` |
| 127 | `r` | `runResult` | `const r = await sandbox.run(PS_ARGV, { timeoutMs: 15_000 });` |
| 147 | `g` | `group` | `const live = new Set(groups.map((g) => g.sid));` |
| 228 | `r` | `runResult` | `const r = await sandbox.run(wrapped, { cwd: args.cwd, timeoutMs, maxBytes: 16 * 1024 * 102` |
| 230 | `e` | `error` | `} catch (e) {` |
| 231 | `te` | `?` | `const te = e as { code?: string; stdout?: Buffer; stderr?: Buffer };` |
| 270 | `e` | `error` | `} catch (e) {` |
| 297 | `r` | `runResult` | `const r = await sandbox.run(['/bin/sh', '-c', script, sidfile], { timeoutMs: 10_000 });` |
| 300 | `e` | `error` | `})().catch((e) => log.warn({ taskId, err: errStr(e) }, 'detached sid capture failed'));` |
| 322 | `r` | `backgroundTaskRow` | `const shapeBackgroundTask = (r: BackgroundTaskRow) => ({` |
| 330 | `r` | `row` | `const running = rows.filter((r) => r.status === 'running');` |
| 336 | `e` | `error` | `catch (e) { log.warn({ err: errStr(e) }, 'task_list reconcile skipped — ps failed'); }` |
| 339 | `r` | `row` | `running: rows.filter((r) => r.status === 'running').map(shapeBackgroundTask),` |
| 340 | `r` | `row` | `recent: rows.filter((r) => r.status !== 'running').slice(0, 10).map(shapeBackgroundTask),` |
| 359 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 1_000));` |
| 386 | `st` | `statResult` | `const st = await fsp.stat(logPath);` |
| 388 | `fh` | `openResult` | `const fh = await fsp.open(logPath, 'r');` |
| 415 | `e` | `error` | `} catch (e) {` |

## phantom-cli/App.tsx — 25

| line | old | new | the line |
|---|---|---|---|
| 182 | `vs` | `?` | `const vs = voice.snapshot();` |
| 286 | `t` | `target` | `const t = setInterval(bump, 1000);` |
| 360 | `m` | `message` | `for (const m of session?.history ?? []) {` |
| 365 | `c` | `char` | `? m.content.filter((c) => (c as { type?: string }).type === 'text')` |
| 366 | `c` | `char` | `.map((c) => (c as { text?: string }).text ?? '').join('')` |
| 445 | `ch` | `channel` | `useInput((ch) => {` |
| 447 | `ev` | `?` | `const ev = parseMouse(ch);` |
| 489 | `sc` | `?` | `const sc = selScroll(sel.pane);` |
| 555 | `t` | `target` | `const t = setTimeout(() => setInterruptArmed(false), 3000);` |
| 579 | `e` | `error` | `if (key.ctrl && ch === 'o') { setExpanded((e) => !e); return; }` |
| 604 | `m` | `message` | `const m = menu.rows;` |
| 642 | `r` | `result` | `const menuPad = Math.max(10, ...(menu.command ? windowStore.argChoices(menu.command) : COM` |
| 708 | `g` | `group` | `.map((g) => g.filter((p): p is ToolbarPart => Boolean(p)))` |
| 709 | `g` | `group` | `.filter((g) => g.length);` |
| 723 | `m` | `message` | `<Boundary name="dialog" resetKey={dialog} onError={(m) => { windowStore.note(`${m} — the q` |
| 743 | `m` | `message` | `<Boundary name={fullOverlay.name} resetKey={fullOverlay.name} onError={(m) => { windowStor` |
| 754 | `m` | `message` | `<Boundary name="conversation" resetKey={session?.id} onError={(m) => windowStore.note(`${m` |
| 759 | `p` | `project` | `keyFor={(p) => p.id}` |
| 760 | `p` | `project` | `render={(p) => <PartView key={p.id} part={p} width={width} expanded={expanded} />}` |
| 772 | `p` | `project` | `{session?.live.map((p) => (` |
| 795 | `m` | `message` | `<Boundary name="prompt" resetKey={windowStore.overlay} onError={(m) => { windowStore.note(` |
| 806 | `m` | `message` | `onError={(m) => { windowStore.note(`${m} — ${thirdOverlay.name} closed; the stack is in ~/` |
| 824 | `c` | `char` | `const c = menuRows[j];` |
| 846 | `v` | `value` | `{!windowStore.hasOverlay && <Prompt value={input} onChange={(v) => { setInput(v); setSugge` |
| 875 | `m` | `message` | `{showSidebar && <Boundary name="voice pane" resetKey={showSidebar} onError={(m) => windowS` |

## phantom-cli/components/Settings.tsx — 25

| line | old | new | the line |
|---|---|---|---|
| 59 | `v` | `value` | `coding_base_url: (v) => !usesBaseUrl(v.coding_provider),` |
| 60 | `v` | `value` | `assistant_base_url: (v) => !usesBaseUrl(set(v.assistant_provider) ?? v.coding_provider),` |
| 61 | `v` | `value` | `supervisor_base_url: (v) => !usesBaseUrl(set(v.supervisor_provider) ?? v.coding_provider),` |
| 62 | `v` | `value` | `voice_wake_words: (v) => v.voice_wake_word !== true,` |
| 63 | `v` | `value` | `voice_wake_timeout: (v) => v.voice_wake_word !== true,` |
| 103 | `e` | `error` | `catch (e) { setNotice(`server unreachable: ${(e as Error).message}`); setServer({}); }` |
| 118 | `r` | `result` | `const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models` |
| 120 | `e` | `error` | `} catch (e) {` |
| 132 | `e` | `error` | `const e = server![key];` |
| 149 | `m` | `message` | `const m = META[key];` |
| 168 | `k` | `key` | `try { await settings.patch(patch); await loadServer(); for (const k of Object.keys(patch))` |
| 169 | `e` | `error` | `catch (e) { setNotice((e as Error).message); }` |
| 172 | `v` | `configValue` | `const writeLocal = async (key: LocalKey, v: ConfigValue) => {` |
| 173 | `t` | `target` | `try { await settings.write(key, v); setNotice(undefined); setTick((t) => t + 1); onChange?` |
| 174 | `e` | `error` | `catch (e) { setNotice(`could not save: ${(e as Error).message}`); }` |
| 186 | `v` | `value` | `onSubmit={(v) => {` |
| 225 | `k` | `key` | `onSelect={(k) => {` |
| 265 | `k` | `key` | `for (const k of LOCAL_KEYS.filter((k) => META[k].group === rows.local)) {` |
| 265 | `k` | `key` | `for (const k of LOCAL_KEYS.filter((k) => META[k].group === rows.local)) {` |
| 266 | `r` | `result` | `const r = local[k];` |
| 272 | `r` | `result` | `return groupBlocks(out, (r) => r);` |
| 295 | `p` | `project` | `const p = MODEL_ROWS[key];` |
| 311 | `p` | `project` | `const keyed = keyedProviders(entries).filter((p) => all.includes(p));` |
| 332 | `m` | `message` | `suggestions: models.map((m) => m.id),` |
| 333 | `m` | `message` | `suggestionLabels: Object.fromEntries(models.map((m) => [m.id, m.name])),` |

## phantom-cli/setup.ts — 23

| line | old | new | the line |
|---|---|---|---|
| 50 | `fd` | `?` | `let fd: number;` |
| 54 | `v` | `value` | `const v = await fn(input);` |
| 60 | `v` | `value` | `text: (message, validate) => onTty((input) => clack.text({ message, input, validate: valid` |
| 69 | `q` | `query` | `const q = typed.toLowerCase();` |
| 70 | `o` | `options` | `const rows = options.filter((o) => !q \|\| o.value.toLowerCase().includes(q) \|\| o.label.toLo` |
| 71 | `o` | `options` | `if (typed && !options.some((o) => o.value === typed)) rows.push({ value: typed, label: `us` |
| 86 | `r` | `apiResult` | `const r = await settings.api('GET', `/models?provider=${encodeURIComponent(provider)}`) as` |
| 89 | `e` | `error` | `} catch (e) {` |
| 95 | `p` | `paired` | `function savePairing(p: Paired, configPath?: string): void {` |
| 136 | `k` | `key` | `for (const k of ['PHANTOM_BACKEND_IMAGE', 'PHANTOM_BACKEND_FS_IMAGE', 'PHANTOM_BACKEND_DIR` |
| 152 | `v` | `value` | `const answer = await ask.text('where does the server go? (user@host or user@host:port)', (` |
| 153 | `t` | `target` | `const t = parseTarget(v);` |
| 157 | `t` | `target` | `const t = parseTarget(answer);` |
| 167 | `e` | `error` | `} catch (e) {` |
| 183 | `v` | `value` | `let v = await verify(paired.url, paired.key, paired.ca);` |
| 185 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 1_000));` |
| 208 | `p` | `project` | `const provider = await ask.select('which AI provider?', PROVIDERS.map((p) => ({` |
| 219 | `v` | `value` | `baseUrl = await ask.text('the endpoint (base URL)', (v) => {` |
| 228 | `m` | `message` | `? await ask.autocomplete(`${provider} model — newest first`, models.map((m) => ({` |
| 230 | `v` | `value` | `: await ask.text(`${provider} model id`, (v) => (v.trim() ? undefined : 'a model id is nee` |
| 240 | `e` | `error` | `} catch (e) {` |
| 260 | `e` | `error` | `} catch (e) {` |
| 277 | `e` | `error` | `} catch (e) {` |

## phantom-backend/telegram/TelegramAssistantBot.ts — 21

| line | old | new | the line |
|---|---|---|---|
| 73 | `e` | `event` | `await deployment.update(tag, { restartAnyway: true }, (e) => { last = e.event; onEvent?.(e` |
| 75 | `e` | `error` | `} catch (e) { return { ok: false, error: (e as Error).message }; }` |
| 110 | `e` | `boardEvent` | `private async alert(projectId: string, e: BoardEvent): Promise<void> {` |
| 117 | `s` | `resolveManyResult` | `const s = await this.backend.settings.resolveMany(` |
| 149 | `m` | `message` | `for (const m of msgs) await this.switchForReply(client, dm, m);` |
| 152 | `m` | `message` | `const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '` |
| 185 | `e` | `error` | `} catch (e) {` |
| 212 | `r` | `switchSessionResult` | `const r = await this.switchSession(client, dm, id);` |
| 228 | `e` | `error` | `catch (e) { return { error: (e as Error).message }; }` |
| 249 | `e` | `error` | `} catch (e) {` |
| 294 | `e` | `error` | `catch (e) {` |
| 297 | `s` | `getResult` | `const s = await this.backend.sessions.get(sessionId);` |
| 310 | `e` | `error` | `} catch (e) {` |
| 334 | `m` | `message` | `const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '` |
| 372 | `r` | `switchSessionResult` | `const r = await this.switchSession(client, dm, repliedSession, { silent: true });` |
| 392 | `s` | `getResult` | `const s = await this.backend.sessions.get(id);` |
| 407 | `t` | `target` | `const changed = await this.backend.telegramBotState.setMode(mode, (t) => client.sendMessag` |
| 419 | `s` | `getResult` | `const s = await this.backend.sessions.get(bot.activeSessionId);` |
| 477 | `s` | `sessionRow` | `fn: ((s: SessionRow, project: ProjectRow, onEvent?: (e: { step: string; detail?: string })` |
| 486 | `e` | `error` | `return await fn(session, project, (e) => {` |
| 491 | `e` | `error` | `} catch (e) { return { result: 'error', reason: (e as Error).message } as T; }` |

## packages/phantom-backend-sdk/src/runtime/Disk.ts — 20

| line | old | new | the line |
|---|---|---|---|
| 67 | `d` | `diskState` | `export function tooFull(d: DiskState, pct: number): boolean {` |
| 76 | `st` | `statfsResult` | `const st = await fs.statfs(root);` |
| 84 | `d` | `diskState` | `const rounded = (d: DiskState) => ({ usedPct: Math.round(d.usedPct), freeGB: Math.round(d.` |
| 93 | `s` | `session` | `.flatMap((s) => {` |
| 99 | `s` | `sessionRow` | `const backupOf = async (gitSync: GitSync, s: SessionRow, project: ProjectRow): Promise<Pus` |
| 100 | `e` | `error` | `gitSync.backup(s, project).catch((e) => {` |
| 111 | `e` | `error` | `try { owners = await workspaceOwners(projects, sessions); } catch (e) {` |
| 120 | `r` | `result` | `const r = await backupOf(gitSync, s, project);` |
| 132 | `v` | `value` | `const v = APP_VERSION;` |
| 149 | `s` | `sessionRow` | `landed: (s: SessionRow, project: ProjectRow) => Promise<boolean>;` |
| 154 | `s` | `sessionRow` | `backup: (s: SessionRow, project: ProjectRow, whenSafe: () => Promise<void>) => Promise<Pus` |
| 156 | `s` | `sessionRow` | `deleteSession: (s: SessionRow) => Promise<void>;` |
| 160 | `d` | `cleanupDeps` | `export async function diskCleanup(d: CleanupDeps): Promise<void> {` |
| 170 | `e` | `error` | `} catch (e) {` |
| 185 | `r` | `backupResult` | `const r = await d.backup(s, project, async () => {` |
| 189 | `e` | `error` | `} catch (e) {` |
| 192 | `e` | `error` | `}).catch((e) => {` |
| 219 | `p` | `paths` | `settings: Settings, projects: Projects, sessions: Sessions, p: Paths, images: Images,` |
| 233 | `e` | `error` | `.catch((e) => log.warn({ err: errStr(e) }, 'image cleanup failed')),` |
| 235 | `s` | `session` | `deleteSession: async (s) => {` |

## phantom-cli/provision.ts — 20

| line | old | new | the line |
|---|---|---|---|
| 52 | `p` | `project` | `const p = Number(host.slice(colon + 1));` |
| 81 | `e` | `error` | `child.on('error', (e) => reject(new Error(`could not run ssh: ${e.message}`)));` |
| 87 | `s` | `session` | `const take = (chunk: Buffer) => { const s = chunk.toString('utf8'); out += s; onData?.(s);` |
| 90 | `e` | `error` | `child.on('error', (e) => reject(new Error(`could not run ssh: ${e.message}`)));` |
| 111 | `t` | `target` | `export function sshArgs(t: Target, command: string, opts: SshOpts & { tty?: boolean } = {}` |
| 126 | `t` | `target` | `export async function closeSshMaster(t: Target, opts: SshOpts = {}): Promise<void> {` |
| 173 | `t` | `target` | `export async function runInstall(t: Target, opts: InstallOptions = {}): Promise<void> {` |
| 177 | `f` | `file` | `const flags = (opts.flags ?? []).map((f) => safe('flag', f)).join(' ');` |
| 180 | `u` | `usage` | `: (() => { const u = safe('url', opts.scriptUrl ?? installScriptUrl());` |
| 202 | `t` | `target` | `export async function readServerFacts(t: Target, opts: SshOpts = {}): Promise<ServerFacts>` |
| 208 | `m` | `match` | `const m = /^PHANTOM_FACT ([A-Z_]+)=(.*)$/.exec(line.trim());` |
| 219 | `t` | `target` | `export async function readServerCa(t: Target, opts: SshOpts = {}): Promise<string> {` |
| 237 | `u` | `usage` | `const u = new URL(`/api${path}`, base);` |
| 248 | `c` | `char` | `res.on('data', (c) => { text += c; });` |
| 272 | `u` | `usage` | `const u = new URL(`/api${path}`, base);` |
| 283 | `c` | `char` | `res.on('data', (c) => { text += c; });` |
| 295 | `nl` | `?` | `let nl: number;` |
| 320 | `u` | `uRL` | `let u: URL;` |
| 327 | `c` | `char` | `res.on('data', (c) => { body += c; });` |
| 339 | `e` | `error` | `req.on('error', (e) => resolvePromise({ ok: false, reason: e.message }));` |

## packages/phantom-backend-sdk/src/tools/files.ts — 19

| line | old | new | the line |
|---|---|---|---|
| 26 | `f` | `fileTools` | `async function readText(f: FileTools, p: string): Promise<string> {` |
| 27 | `r` | `readFileResult` | `const r = await f.sandbox.readFile(p);` |
| 41 | `l` | `line` | `return lines.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');` |
| 50 | `to` | `?` | `let to = Math.min(total, from + limit - 1);` |
| 158 | `f` | `filesResult` | `const f = await ctx.files();` |
| 159 | `p` | `project` | `const p = s(a.path);` |
| 162 | `r` | `readFileResult` | `const r = await f.sandbox.readFile(p);` |
| 182 | `p` | `project` | `const p = s(a.path);` |
| 212 | `f` | `filesResult` | `const f = await ctx.files();` |
| 213 | `p` | `project` | `const p = s(a.path);` |
| 214 | `e` | `error` | `const before = await readText(f, p).catch((e: ToolError) => {` |
| 229 | `e` | `error` | `const e = list[i];` |
| 259 | `p` | `project` | `const p = Sandbox.resolvePath(s(a.path ?? '.'));` |
| 260 | `r` | `result` | `const r = await (await ctx.files()).sandbox.run(['ls', '-1Ap', p]);` |
| 262 | `e` | `error` | `const e = r.stderr.toString('utf8');` |
| 291 | `f` | `filesResult` | `const f = await ctx.files();` |
| 294 | `r` | `runResult` | `const r = await f.sandbox.run(argv);` |
| 323 | `f` | `filesResult` | `const f = await ctx.files();` |
| 329 | `r` | `runResult` | `const r = await f.sandbox.run(argv, { maxBytes: 8 * 1024 * 1024 });` |

## packages/phantom-client-sdk/src/model/languageModel.ts — 17

| line | old | new | the line |
|---|---|---|---|
| 33 | `e` | `error` | `onBillingError: (e: PhantomError) => void;` |
| 75 | `e` | `error` | `} catch (e) {` |
| 84 | `s` | `modelSpec` | `function anthropicProvider(s: ModelSpec, f: typeof fetch) {` |
| 106 | `s` | `modelSpec` | `function codexSession(s: ModelSpec): OpenAIOAuthSession {` |
| 110 | `e` | `error` | `} catch (e) {` |
| 116 | `s` | `modelSpec` | `function openaiCodexModel(s: ModelSpec, f: typeof fetch): Exclude<LanguageModel, string> {` |
| 137 | `s` | `pick` | `export function effectiveReasoning(s: Pick<ModelSpec, 'provider' \| 'model' \| 'reasoning'>)` |
| 145 | `s` | `modelSpec` | `function keyFor(s: ModelSpec): string {` |
| 150 | `s` | `modelSpec` | `function providerModel(s: ModelSpec, f: typeof fetch): Exclude<LanguageModel, string> {` |
| 151 | `ep` | `?` | `const ep = s.baseUrl ?? undefined;` |
| 172 | `s` | `modelSpec` | `function billingMiddleware(s: ModelSpec, usage: (u: TokenUsage) => void): LanguageModelMid` |
| 172 | `u` | `tokenUsage` | `function billingMiddleware(s: ModelSpec, usage: (u: TokenUsage) => void): LanguageModelMid` |
| 181 | `r` | `result` | `const r = await doGenerate();` |
| 186 | `r` | `result` | `const r = await doStream();` |
| 201 | `s` | `modelSpec` | `export function billedModel(backend: BackendClient, s: ModelSpec, bill: Billing, hooks: Mo` |
| 203 | `u` | `tokenUsage` | `const post = (u: TokenUsage) => backend.call('POST', '/log-tokens', { type: bill.type, ses` |
| 205 | `u` | `usage` | `return wrapLanguageModel({ model, middleware: billingMiddleware(s, (u) => { void post(u); ` |

## phantom-cli/index.tsx — 17

| line | old | new | the line |
|---|---|---|---|
| 57 | `l` | `line` | `const l = localValues();` |
| 68 | `h` | `header` | `? await server.call('GET', '/health').then((h) => String((h as { version?: string }).versi` |
| 80 | `r` | `result` | `const r = installVersion(thisBuildDir());` |
| 82 | `v` | `value` | `for (const v of r.removed) console.log(`  removed ${v}`);` |
| 83 | `e` | `error` | `} catch (e) { die(`install failed: ${e instanceof Error ? e.message : String(e)}`); }` |
| 88 | `f` | `file` | `const bad = flags.find((f) => f !== '--client' && f !== '--server');` |
| 99 | `r` | `wake` | `sleep: (ms) => new Promise((r) => setTimeout(r, ms)),` |
| 126 | `fd` | `?` | `let fd: number;` |
| 132 | `rl` | `?` | `const rl = createInterface({ input, output: process.stdout });` |
| 133 | `r` | `result` | `const answer = await new Promise<string>((r) => rl.question(question, r));` |
| 186 | `r` | `result` | `}).then((r) => {` |
| 206 | `r` | `wake` | `sleep: (ms) => new Promise((r) => setTimeout(r, ms)),` |
| 213 | `r` | `result` | `const r = spawnSync(join(APP_ROOT, version, 'bin', 'phantom-cli'), process.argv.slice(2), ` |
| 236 | `h` | `header` | `.then((h) => { serverVersion = String((h as { version?: string }).version ?? ''); })` |
| 284 | `r` | `wake` | `await new Promise((r) => setTimeout(r, CPR_DRAIN_MS));` |
| 304 | `m` | `message` | `for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {` |
| 351 | `s` | `session` | `onSession={(s) => { currentId = s.id; }}` |

## packages/phantom-backend-sdk/src/telegram/TelegramBot.ts — 16

| line | old | new | the line |
|---|---|---|---|
| 52 | `v` | `value` | `const v = msg?.[field];` |
| 59 | `r` | `result` | `return Array.isArray(list) && list.some((r) => r?.type === 'emoji' && r?.emoji === emoji);` |
| 147 | `me` | `getMeResult` | `const me = await api.getMe().catch((e: Error) => { log.warn({ err: e.message }, 'getMe fai` |
| 147 | `e` | `error` | `const me = await api.getMe().catch((e: Error) => { log.warn({ err: e.message }, 'getMe fai` |
| 149 | `e` | `error` | `const info = await api.getWebhookInfo().catch((e: Error) => { log.warn({ err: e.message },` |
| 151 | `u` | `usage` | `&& ALLOWED_UPDATES.every((u) => (info?.allowed_updates ?? []).includes(u));` |
| 192 | `e` | `error` | `} catch (e) {` |
| 212 | `e` | `error` | `(e) => log.warn({ err: errStr(e) }, 'sent message not recorded')); },` |
| 214 | `e` | `error` | `(e) => log.warn({ err: errStr(e) }, 'sent message not forgotten')); });` |
| 241 | `e` | `error` | `this.speakRepliedMessage(reaction, dm).catch((e) => log.warn({ err: errStr(e) }, 'speak-re` |
| 243 | `e` | `error` | `this.#onReaction?.(dm, reaction).catch((e) => log.warn({ err: errStr(e) }, 'reaction handl` |
| 255 | `e` | `error` | `this.#approvals.handleCallback(api, dm, query).catch((e) => log.warn({ err: errStr(e) }, '` |
| 257 | `e` | `error` | `this.#onButton?.(dm, query, api).catch((e) => log.warn({ err: errStr(e) }, 'button handler` |
| 270 | `e` | `error` | `const deliver = (msgs: any[]) => this.#onMessage?.(dm, msgs).catch((e) => log.error({ err:` |
| 322 | `e` | `error` | `.catch(async (e) => { await react(); throw e; });` |
| 360 | `p` | `project` | `return { roots: [root], toHost: (p) => p.startsWith('/workspace') ? path.join(root, p.slic` |

## packages/phantom-backend-sdk/src/runtime/CheckoutPool.ts — 16

| line | old | new | the line |
|---|---|---|---|
| 34 | `rm` | `?` | `const rm = (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => {});` |
| 41 | `r` | `projectRow` | `export async function resolveAuth(settings: Settings, r: ProjectRow): Promise<GitAuth> {` |
| 50 | `p` | `paths` | `p: Paths, owner: string, name: string, branch: string, dest: string,` |
| 74 | `p` | `paths` | `export async function tick(projects: Projects, settings: Settings, p: Paths): Promise<void` |
| 82 | `e` | `error` | `try { projectRows = await projects.list(); } catch (e) {` |
| 90 | `st` | `statResult` | `const st = await fs.stat(path.join(p.poolSetup, slot)).catch(() => null);` |
| 94 | `r` | `row` | `const wanted = new Map(projectRows.map((r) => [slotPrefix(r.owner, r.name, r.baseBranch), ` |
| 113 | `s` | `session` | `let mine = ready.filter((s) => s.startsWith(prefix));` |
| 123 | `s` | `session` | `mine = mine.filter((s) => s !== slot);` |
| 132 | `st` | `statResult` | `const st = await fs.stat(full).catch(() => null);` |
| 133 | `s` | `session` | `if (!st) { mine = mine.filter((s) => s !== slot); continue; }` |
| 138 | `e` | `error` | `} catch (e) {` |
| 141 | `s` | `session` | `mine = mine.filter((s) => s !== slot);` |
| 157 | `e` | `error` | `} catch (e) {` |
| 163 | `e` | `error` | `} catch (e) {` |
| 171 | `p` | `paths` | `export async function bootCleanup(p: Paths): Promise<void> {` |

## packages/phantom-backend-sdk/src/git/Git.ts — 15

| line | old | new | the line |
|---|---|---|---|
| 70 | `x` | `?` | `const x = e as Error & { stderr?: string; stdout?: string; code?: unknown };` |
| 142 | `e` | `error` | `.catch((e) => log.debug({ dir, err: errStr(e) }, 'no history in window — staying at depth ` |
| 172 | `e` | `error` | `} catch (e) {` |
| 194 | `e` | `error` | `} catch (e) {` |
| 208 | `e` | `error` | `} catch (e) {` |
| 242 | `e` | `error` | `} catch (e) {` |
| 249 | `e` | `error` | `} catch (e) {` |
| 288 | `e` | `error` | `} catch (e) {` |
| 310 | `e` | `error` | `} catch (e) {` |
| 311 | `s` | `session` | `const s = String((e as { stderr?: string }).stderr ?? e);` |
| 371 | `e` | `error` | `} catch (e) {` |
| 384 | `d` | `data` | `for (const d of ['rebase-merge', 'rebase-apply']) {` |
| 422 | `e` | `error` | `} catch (e) {` |
| 451 | `e` | `error` | `} catch (e) {` |
| 462 | `e` | `error` | `} catch (e) {` |

## phantom-cli/components/Secrets.tsx — 15

| line | old | new | the line |
|---|---|---|---|
| 57 | `e` | `error` | `} catch (e) { setNotice(`could not load: ${(e as Error).message}`); setRows([]); }` |
| 66 | `x` | `?` | `const project = id ? projects.find((x) => x.id === id) : undefined;` |
| 69 | `r` | `row` | `const layerOf = (r: Row) => (r.scope === 'project' ? wsName(r.project) : GLOBAL_TAG);` |
| 83 | `e` | `error` | `.then(() => after, (e: Error) => e.message)` |
| 89 | `d` | `secretDraft` | `const put = (d: SecretDraft, value?: string) =>` |
| 93 | `d` | `secretDraft` | `const save = (d: SecretDraft) => {` |
| 113 | `r` | `row` | `const shown = (rows ?? []).filter((r) => filter === null \|\| r.project === filter);` |
| 141 | `r` | `row` | `const choice = (r: Row): Choice<string> => ({` |
| 149 | `r` | `result` | `[GLOBAL_TAG, shown.filter((r) => r.scope === 'global')],` |
| 150 | `r` | `row` | `...projects.map((project): [string, Row[]] => [wsName(project.id), shown.filter((r) => r.p` |
| 176 | `v` | `value` | `onSelect={(v) => {` |
| 178 | `r` | `row` | `const row = shown.find((r) => keyOf(r.project, r.name) === v);` |
| 182 | `ch` | `channel` | `onKey={(ch, v) => {` |
| 182 | `v` | `value` | `onKey={(ch, v) => {` |
| 185 | `r` | `row` | `const row = shown.find((r) => keyOf(r.project, r.name) === v);` |

## phantom-cli/components/Parts.tsx — 15

| line | old | new | the line |
|---|---|---|---|
| 36 | `n` | `count` | `let n = 0;` |
| 37 | `ch` | `channel` | `for (const ch of s) n += WIDE.test(ch) ? 2 : 1;` |
| 53 | `n` | `count` | `for (let n = 0; n < all.length; n++) {` |
| 55 | `r` | `row` | `const r = rowsFor(all[i], out.length === 0 && keep === 'head' ? Math.max(1, firstWidth) : ` |
| 233 | `d` | `data` | `const d = (output as { data?: { truncated?: { full_output?: unknown } } } \| undefined)?.da` |
| 234 | `p` | `project` | `const p = d?.truncated?.full_output;` |
| 266 | `o` | `options` | `return `${card} ${ops.map((o) => o.op ?? '?').join(', ')}`.slice(0, 80);` |
| 269 | `c` | `char` | `const c: string[] = [];` |
| 286 | `d` | `data` | `const d = env && typeof env === 'object' && 'data' in env ? env.data : output;` |
| 291 | `o` | `options` | `const o = d as Record<string, unknown>;` |
| 303 | `o` | `options` | `const o = d as Record<string, unknown>;` |
| 309 | `s` | `session` | `const text = [o.stdout, o.stderr].filter((s) => typeof s === 'string' && s.trim()).join('\` |
| 332 | `o` | `record` | `function summarizeEdit(o: Record<string, unknown>): string {` |
| 340 | `n` | `count` | `const n = edits.reduce((sum, e) => sum + (typeof e.replacements === 'number' ? e.replaceme` |
| 341 | `e` | `error` | `const strategies = [...new Set(edits.map((e) => e.strategy).filter((x): x is string => typ` |

## phantom-cli/trim.ts — 14

| line | old | new | the line |
|---|---|---|---|
| 38 | `p` | `project` | `const p = params === '' ? [0] : params.split(';').map((x) => (x === '' ? 0 : Number(x)));` |
| 38 | `x` | `?` | `const p = params === '' ? [0] : params.split(';').map((x) => (x === '' ? 0 : Number(x)));` |
| 40 | `c` | `char` | `const c = p[i];` |
| 99 | `m` | `match` | `const m = CSI.exec(run.slice(i));` |
| 121 | `y` | `?` | `const y = row as number;` |
| 125 | `m` | `message` | `for (const m of run.matchAll(/\x1b\[([0-9;]*)m/g)) sgr.apply(m[1]);` |
| 129 | `p` | `project` | `let p = 0;` |
| 142 | `r` | `result` | `const r = run;` |
| 148 | `m` | `message` | `for (const m of r.matchAll(/\x1b\[([0-9;]*)m/g)) sgr.apply(m[1]);` |
| 153 | `ch` | `channel` | `const ch = chunk[i];` |
| 155 | `m` | `match` | `const m = CSI.exec(chunk.slice(i));` |
| 178 | `n` | `count` | `const n = params === '' ? 1 : Number(params.split(';')[0]) \|\| 1;` |
| 185 | `x` | `?` | `const [r, c] = params.split(';').map((x) => Number(x) \|\| 1);` |
| 209 | `nl` | `?` | `const nl = chunk.indexOf('\n', i), cr = chunk.indexOf('\r', i);` |

## phantom-cli/update.ts — 14

| line | old | new | the line |
|---|---|---|---|
| 73 | `s` | `session` | `const s = Math.floor(ms / 1000);` |
| 78 | `m` | `message` | `const m = Math.max(1, Math.round(ms / 60_000));` |
| 83 | `d` | `updateDeps` | `async function waitForVersion(d: UpdateDeps, server: ServerLink, version: string):` |
| 94 | `h` | `header` | `const h = await readHealth(server);` |
| 109 | `d` | `updateDeps` | `async function streamUpdateProgress(d: UpdateDeps, server: ServerLink, tag: string):` |
| 117 | `e` | `error` | `const e = raw as UpdateEvent;` |
| 135 | `e` | `error` | `} catch (e) {` |
| 145 | `d` | `updateDeps` | `export async function runUpdate(target: Target, d: UpdateDeps): Promise<number> {` |
| 148 | `v` | `value` | `const v = bare(latest);` |
| 180 | `e` | `error` | `} catch (e) {` |
| 201 | `n` | `count` | `const n = health?.loops_running ?? 0;` |
| 216 | `r` | `result` | `const r = await waitForVersion(d, d.server, v);` |
| 255 | `v` | `value` | `const v = bare(latest);` |
| 257 | `s` | `session` | `const s = server ? bare(server) : null;` |

## phantom-cli/components/VoicePanel.tsx — 14

| line | old | new | the line |
|---|---|---|---|
| 60 | `x` | `?` | `let x = 0;` |
| 61 | `it` | `?` | `for (const it of items) {` |
| 71 | `n` | `count` | `<Box ref={(n) => { rowRef.current = n; }}>` |
| 73 | `it` | `?` | `{items.map((it, i) => (` |
| 117 | `t` | `target` | `const t = setInterval(() => setTick((x) => x + 1), 1000);` |
| 117 | `x` | `?` | `const t = setInterval(() => setTick((x) => x + 1), 1000);` |
| 150 | `m` | `message` | `const m = measureElement(node);` |
| 153 | `s` | `session` | `return spans(row).find((s) => rel >= s.from && rel < s.to)?.key ?? null;` |
| 160 | `m` | `message` | `const m = measureElement(node);` |
| 169 | `ch` | `channel` | `useInput((ch) => {` |
| 171 | `ev` | `?` | `const ev = parseMouse(ch);` |
| 209 | `p` | `project` | `<Pane items={items} offset={offset} width={inner} onMeasure={onMeasure} keyFor={(p) => p.i` |
| 210 | `p` | `project` | `render={(p) => <PartView key={p.id} part={p} width={inner} expanded={expanded} maxRows={8}` |
| 218 | `n` | `count` | `<Box ref={(n) => { answersRef.current = n; }}>` |

## packages/phantom-backend-sdk/src/telegram/mediaTags.ts — 13

| line | old | new | the line |
|---|---|---|---|
| 33 | `e` | `error` | `.map((e) => e.slice(1)).sort((a, b) => b.length - a.length).join('\|');` |
| 63 | `m` | `message` | `for (const m of content.matchAll(/```[^\n]*\n[\s\S]*?```/g)) spans.push([m.index!, m.index` |
| 64 | `m` | `message` | `for (const m of content.matchAll(/`[^`\n]+`/g)) {` |
| 68 | `m` | `message` | `for (const m of content.matchAll(/^>.*$/gm)) spans.push([m.index!, m.index! + m[0].length]` |
| 78 | `m` | `message` | `for (const m of content.matchAll(/(?<=[:,{[])\s*"((?:[^"\\\n]\|\\.)*)"/g)) {` |
| 87 | `p` | `project` | `let p = String(raw ?? '').trim();` |
| 104 | `m` | `message` | `for (const m of scan.matchAll(mediaTagRe())) {` |
| 105 | `p` | `project` | `const p = unquote(m.groups?.path);` |
| 111 | `m` | `message` | `for (const m of maskedCleaned.matchAll(mediaTagRe())) spans.push([m.index!, m.index! + m[0` |
| 127 | `m` | `message` | `for (const m of src.matchAll(/```[^\n]*\n[\s\S]*?```/g)) codeSpans.push([m.index!, m.index` |
| 128 | `m` | `message` | `for (const m of src.matchAll(/`[^`\n]+`/g)) codeSpans.push([m.index!, m.index! + m[0].leng` |
| 132 | `m` | `message` | `for (const m of src.matchAll(barePathRe())) {` |
| 193 | `p` | `project` | `...bare.paths.map((p) => ({ path: p, isVoice: false })),` |

## packages/phantom-backend-sdk/src/git/GitSync.ts — 13

| line | old | new | the line |
|---|---|---|---|
| 37 | `e` | `syncEvent` | `private onSyncEvent?: (sessionId: string, e: SyncEvent) => void,` |
| 51 | `s` | `sessionRow` | `private async workspaceOf(s: SessionRow): Promise<WorkspaceRow> {` |
| 67 | `s` | `sessionRow` | `async backup(s: SessionRow, project: ProjectRow, whenSafe?: () => Promise<void>): Promise<` |
| 71 | `e` | `error` | `.catch((e) => log.warn({ session: s.id, err: errStr(e) }, 'backup lock renewal failed'));` |
| 74 | `r` | `pushResult` | `const r = await this.push(s, project);` |
| 86 | `s` | `sessionRow` | `async push(s: SessionRow, project: ProjectRow): Promise<PushResult \| 'busy'> {` |
| 97 | `r` | `result` | `const r = await pushSession(dir, workspace.branch, await this.auth(project));` |
| 102 | `e` | `error` | `} catch (e) {` |
| 116 | `s` | `sessionRow` | `async pull(s: SessionRow, project: ProjectRow): Promise<PullResult \| 'busy'> {` |
| 117 | `r` | `result` | `const r = await syncBranch(` |
| 118 | `e` | `error` | `{ ...this.deps, onEvent: (e) => this.onSyncEvent?.(s.id, e) },` |
| 137 | `s` | `sessionRow` | `async status(s: SessionRow, project: ProjectRow): Promise<{` |
| 145 | `e` | `error` | `await git(dir, ['fetch', 'origin', project.baseBranch], await this.auth(project)).catch((e` |

## packages/phantom-backend-sdk/src/upgrade/Deployment.ts — 13

| line | old | new | the line |
|---|---|---|---|
| 62 | `e` | `updateEvent` | `update(tag: string, o: { restartAnyway?: boolean }, onEvent: (e: UpdateEvent) => void): { ` |
| 76 | `e` | `error` | `unsub = subscribe((e) => {` |
| 101 | `d` | `buffer` | `sink.on('data', (d: Buffer) => out.push(d));` |
| 124 | `e` | `error` | `catch (e) {` |
| 130 | `re` | `?` | `try { const re = new RegExp(grep, 'i'); keep = (line) => re.test(line); }` |
| 143 | `c` | `char` | `const times = () => os.cpus().map((c) => ({ ...c.times }));` |
| 145 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 250));` |
| 155 | `n` | `count` | `const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');` |
| 172 | `e` | `error` | `const all = await docker.listContainers().catch((e) => { log.error({ err: errStr(e) }, 'co` |
| 174 | `c` | `char` | `const target = all.find((c) => (c.Labels?.['com.docker.compose.service'] ?? '') === servic` |
| 176 | `c` | `char` | `const services = [...new Set(all.map((c) => c.Labels?.['com.docker.compose.service']).filt` |
| 182 | `e` | `error` | `setTimeout(() => { container.restart().catch((e) => log.warn({ err: errStr(e) }, 'api self` |
| 187 | `e` | `error` | `catch (e) {` |

## packages/phantom-backend-sdk/src/runtime/Sandbox.ts — 13

| line | old | new | the line |
|---|---|---|---|
| 44 | `e` | `error` | `catch (e) {` |
| 47 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));` |
| 67 | `d` | `buffer` | `outSink.on('data', (d: Buffer) => { if (outLen < max) { out.push(d); outLen += d.length; }` |
| 68 | `d` | `buffer` | `errSink.on('data', (d: Buffer) => { if (errLen < max) { errB.push(d); errLen += d.length; ` |
| 74 | `t` | `target` | `const t = opts.timeoutMs` |
| 81 | `e` | `error` | `stream.on('error', (e) => { if (t) clearTimeout(t); rejectP(e); });` |
| 101 | `d` | `buffer` | `outSink.on('data', (d: Buffer) => { chunks.push({ stream: 'stdout', data: d }); wake?.(); ` |
| 102 | `d` | `buffer` | `errSink.on('data', (d: Buffer) => { chunks.push({ stream: 'stderr', data: d }); wake?.(); ` |
| 105 | `e` | `error` | `stream.on('error', (e) => { failed = e; done = true; wake?.(); });` |
| 114 | `c` | `char` | `const c = chunks.shift()!;` |
| 118 | `r` | `result` | `await new Promise<void>((r) => { wake = r; });` |
| 135 | `r` | `runResult` | `const r = await this.run(['cat', abs], { maxBytes: opts.maxBytes });` |
| 145 | `r` | `runResult` | `const r = await this.run(['sh', '-c', 'cat > "$1"', 'sh', abs], { stdin: content });` |

## phantom-cli/components/Launcher.tsx — 13

| line | old | new | the line |
|---|---|---|---|
| 60 | `s` | `session` | `.filter((s) => whoDrives(s) === 'manual' && known.has(s.projectId))` |
| 95 | `s` | `sessionInfo` | `const inMotion = (s: SessionInfo) => isRunning(s, { busy, clientId });` |
| 117 | `s` | `sessionInfo` | `const wsCol = (s: SessionInfo): string => {` |
| 211 | `s` | `session` | `const pinnedCount = sessions.filter((s) => s.pinned === true).length;` |
| 228 | `x` | `?` | `const project = id ? projects.find((x) => x.id === id) : undefined;` |
| 289 | `l` | `launch` | `onPick: (l: Launch) => void;` |
| 355 | `q` | `query` | `<TextInput value={query} onChange={(q) => onQuery!(q)} placeholder="name, last message or ` |
| 362 | `v` | `value` | `onSelect={(v) => { if (v) onPick(v); }}` |
| 392 | `v` | `value` | `onSelect={(v) => { if (v) onPick(v); }}` |
| 393 | `ch` | `channel` | `onKey={canEdit ? (ch, v) => {` |
| 393 | `v` | `value` | `onKey={canEdit ? (ch, v) => {` |
| 397 | `ch` | `channel` | `} : mode === 'sessions' ? (ch, v) => {` |
| 397 | `v` | `value` | `} : mode === 'sessions' ? (ch, v) => {` |

## phantom-cli/components/ProjectSettings.tsx — 13

| line | old | new | the line |
|---|---|---|---|
| 75 | `s` | `effective` | `const shownValue = (s: Effective) =>` |
| 112 | `r` | `result` | `const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models` |
| 114 | `e` | `error` | `} catch (e) { setNotice(`could not load the model list: ${(e as Error).message}`); return ` |
| 161 | `v` | `value` | `onSubmit={(v) => {` |
| 193 | `k` | `key` | `const overridable = Object.keys(eff).filter((k) => eff[k].overridable && !HIDDEN[k]?.(valu` |
| 194 | `k` | `key` | `const settingRows = headedChoices(groupBlocks(overridable, (k) => eff[k].meta), (k) => {` |
| 194 | `k` | `key` | `const settingRows = headedChoices(groupBlocks(overridable, (k) => eff[k].meta), (k) => {` |
| 195 | `s` | `session` | `const s = eff[k];` |
| 238 | `k` | `key` | `onSelect={(k) => {` |
| 250 | `s` | `session` | `const s = eff[k];` |
| 271 | `ch` | `channel` | `onKey={(ch, k) => {` |
| 271 | `k` | `key` | `onKey={(ch, k) => {` |
| 280 | `s` | `session` | `const s = eff[k];` |

## packages/phantom-backend-sdk/src/storage/AgentDatabases.ts — 12

| line | old | new | the line |
|---|---|---|---|
| 111 | `s` | `session` | `const s = JSON.stringify(v);` |
| 152 | `u` | `usage` | `const u = new URL(this.server.toString());` |
| 166 | `p` | `project` | `const p = this.ensureInner(projectId)` |
| 214 | `o` | `queryOptions` | `async query(projectId: string, sql: string, o: QueryOptions): Promise<StatementResult[]> {` |
| 229 | `q` | `query` | `const q = new pg.Query(config);` |
| 236 | `r` | `result` | `q.on('end', (r) => resolve(Array.isArray(r) ? r : [r]));` |
| 240 | `r` | `result` | `return results.map((r) => {` |
| 241 | `f` | `file` | `const names = r.fields.map((f) => f.name);` |
| 242 | `n` | `count` | `const dup = names.find((n, i) => names.indexOf(n) !== i);` |
| 245 | `n` | `count` | `Object.fromEntries(names.map((n, i) => [n, cell(row[i], o.maxCellChars)])));` |
| 248 | `e` | `error` | `} catch (e) {` |
| 250 | `pe` | `?` | `const pe = e as { message: string; code?: string; detail?: string; hint?: string; position` |

## packages/phantom-backend-sdk/src/storage/Cards.ts — 12

| line | old | new | the line |
|---|---|---|---|
| 85 | `q` | `query` | `let q = this.db.select().from(cards).where(and(archived, older)).orderBy(desc(cards.update` |
| 133 | `f` | `file` | `for (const f of CARD_FIELDS)` |
| 159 | `o` | `options` | `for (const o of items ?? []) {` |
| 167 | `f` | `file` | `for (const f of CARD_FIELDS) if (f in fields) set[f] = fields[f] as never;` |
| 218 | `o` | `itemOp` | `const at = (o: ItemOp) => list.findIndex((e) => normalizeKey(e.key) === normalizeKey(o.key` |
| 218 | `e` | `error` | `const at = (o: ItemOp) => list.findIndex((e) => normalizeKey(e.key) === normalizeKey(o.key` |
| 219 | `o` | `options` | `const missing = items.filter((o) => o.op !== 'add' && at(o) < 0);` |
| 222 | `o` | `options` | `missing.map((o) => `no "${o.key}" in requirements — the keys: ${list.map((e) => e.key).joi` |
| 222 | `e` | `error` | `missing.map((o) => `no "${o.key}" in requirements — the keys: ${list.map((e) => e.key).joi` |
| 224 | `o` | `options` | `for (const o of items) {` |
| 227 | `e` | `error` | `while (list.some((e) => e.key === key)) key = newKey();` |
| 233 | `e` | `error` | `list = list.map((e, j) => j !== i ? e` |

## packages/phantom-backend-sdk/src/skills/skills.ts — 12

| line | old | new | the line |
|---|---|---|---|
| 25 | `m` | `match` | `const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n\|$)/);` |
| 37 | `l` | `line` | `const i = lines.findIndex((l) => /^description:/.test(l));` |
| 43 | `l` | `line` | `const l = lines[j];` |
| 48 | `v` | `value` | `const v = out.join(' ').replace(/\s+/g, ' ').trim();` |
| 51 | `v` | `value` | `const v = head.replace(/^["']\|["']$/g, '').trim();` |
| 59 | `m` | `match` | `const m = parts.fm.match(/^name:\s*(.+)$/m);` |
| 60 | `v` | `value` | `const v = m ? m[1].trim().replace(/^["']\|["']$/g, '').trim() : '';` |
| 73 | `e` | `error` | `.filter((e) => e.isDirectory() \|\| e.isSymbolicLink()).map((e) => e.name);` |
| 73 | `e` | `error` | `.filter((e) => e.isDirectory() \|\| e.isSymbolicLink()).map((e) => e.name);` |
| 74 | `e` | `error` | `} catch (e) {` |
| 82 | `md` | `readFileResult` | `const md = await fsp.readFile(path.join(dir, name, 'SKILL.md'), 'utf8').catch(() => null);` |
| 97 | `s` | `session` | `for (const list of lists) for (const s of list) {` |

## packages/phantom-backend-sdk/src/runtime/SessionContainers.ts — 12

| line | old | new | the line |
|---|---|---|---|
| 141 | `e` | `error` | `.catch((e) => { log.warn({ err: errStr(e) }, 'could not list containers'); return []; });` |
| 142 | `c` | `char` | `return list.flatMap((c) => (c.Names ?? [])` |
| 143 | `n` | `count` | `.map((n) => n.replace(/^\//, ''))` |
| 144 | `n` | `count` | `.filter((n) => n.startsWith(NAME_PREFIX))` |
| 145 | `n` | `count` | `.map((n) => n.slice(NAME_PREFIX.length)));` |
| 156 | `p` | `project` | `const p = this.ensureInner(workspaceId, project).finally(() => this.inflight.delete(worksp` |
| 162 | `c` | `char` | `const c = this.docker.getContainer(this.name(key));` |
| 194 | `e` | `error` | `} catch (e) {` |
| 207 | `e` | `error` | `.catch((e) => log.warn({ workspace: key, err: errStr(e) }, 'onStarted listener failed — co` |
| 254 | `e` | `error` | `await this.docker.getContainer(this.name(workspaceId)).remove({ force: true, v: true }).ca` |
| 258 | `e` | `error` | `.catch((e) => log.warn({ workspace: workspaceId, err: errStr(e) }, 'onRemoved listener fai` |
| 269 | `e` | `error` | `} catch (e) {` |

## phantom-cli/kanban.ts — 12

| line | old | new | the line |
|---|---|---|---|
| 10 | `t` | `card` | `const cardSummary = (t: Card) =>` |
| 18 | `t` | `card` | `const cardWithLists = (t: Card) => ({ ...cardSummary(t),` |
| 26 | `c` | `char` | `return board.state.columns.find((c) => c.toLowerCase() === want);` |
| 46 | `c` | `card` | `cards: board.state.columns.flatMap((c) => board.cardsIn(c).map(cardSummary)) };` |
| 53 | `c` | `char` | `requirements: args.requirements?.map((c) => ({ ...c, done: c.done ?? false })) });` |
| 55 | `e` | `error` | `} catch (e) { return { error: (e as Error).message }; }` |
| 62 | `e` | `error` | `catch (e) { return { error: (e as Error).message }; }` |
| 67 | `t` | `target` | `let t = args.card !== undefined ? board.byNumber(args.card) : undefined;` |
| 70 | `e` | `error` | `catch (e) { return { error: `could not read card ${args.card}: ${(e as Error).message}` };` |
| 88 | `f` | `file` | `for (const f of ['title', 'details', 'blocked_reason', 'auto_plan', 'auto_build', 'pinned'` |
| 92 | `c` | `char` | `patch.requirements = args.requirements.map((c) => ({ ...c, done: c.done ?? false }));` |
| 97 | `x` | `?` | `const fresh = board.state.cards.find((x) => x.id === t.id);` |

## phantom-cli/components/SelectList.tsx — 12

| line | old | new | the line |
|---|---|---|---|
| 140 | `c` | `char` | `const pickable = choices.map((c, i) => (c.heading ? -1 : i)).filter((i) => i >= 0);` |
| 142 | `c` | `char` | `const at = initial === undefined ? -1 : choices.findIndex((c) => !c.heading && c.value ===` |
| 163 | `p` | `project` | `return pickable.find((p) => p > i) ?? pickable.filter((p) => p < i).pop() ?? 0;` |
| 163 | `p` | `project` | `return pickable.find((p) => p > i) ?? pickable.filter((p) => p < i).pop() ?? 0;` |
| 177 | `c` | `choice` | `const keyOf = (c: Choice<T> \| undefined) =>` |
| 189 | `c` | `char` | `const at = choices.findIndex((c) => keyOf(c) === held.current);` |
| 226 | `c` | `char` | `const c = choices[normalize(cursorRef.current)];` |
| 233 | `c` | `char` | `else if (key.return) { const c = current(); if (c) onSelect(c.value); }` |
| 259 | `cs` | `choice` | `const rowsIn = (cs: Choice<T>[]) => cs.filter((c) => !c.heading).length;` |
| 259 | `c` | `char` | `const rowsIn = (cs: Choice<T>[]) => cs.filter((c) => !c.heading).length;` |
| 268 | `c` | `char` | `const hasMarkers = choices.some((c) => c.busy \|\| c.dot \|\| c.lock);` |
| 278 | `c` | `char` | `{window.map((c, i) => {` |

## packages/phantom-client-sdk/src/agent.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 122 | `p` | `project` | `const p = this.#guard(() => this.#turnBody([...this.#queue.drain(), text]));` |
| 181 | `r` | `turnResult` | `let r: TurnResult;` |
| 198 | `e` | `error` | `} catch (e) {` |
| 208 | `e` | `error` | `} catch (e) {` |
| 250 | `e` | `error` | `} catch (e) {` |
| 264 | `e` | `error` | `onBillingError: (e) => this.#handlers.onError(e),` |
| 272 | `e` | `error` | `catch (e) {` |
| 273 | `pe` | `?` | `const pe = asPhantomError(e, 'internal', 'agent');` |
| 280 | `e` | `error` | `this.#events.emit(event, payload, (e) => this.#handlers.onError(asPhantomError(e, 'listene` |
| 291 | `e` | `error` | `} catch (e) {` |
| 292 | `pe` | `?` | `const pe = asPhantomError(e, 'internal', what);` |

## packages/phantom-backend-sdk/src/tools/fuzzy.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 155 | `l` | `line` | `const patternNormalized = pattern.split('\n').map((l) => l.trim()).join('\n');` |
| 157 | `l` | `line` | `const contentNormalizedLines = contentLines.map((l) => l.trim());` |
| 170 | `l` | `line` | `const contentStrippedLines = contentLines.map((l) => l.replace(/^\s+/, ''));` |
| 171 | `l` | `line` | `const patternNormalized = pattern.split('\n').map((l) => l.replace(/^\s+/, '')).join('\n')` |
| 205 | `ch` | `channel` | `for (const ch of original) {` |
| 285 | `k` | `key` | `for (let k = 0; k < count; k++) {` |
| 353 | `n` | `count` | `origStart = origToNorm.findIndex((n) => n >= normStart);` |
| 379 | `js` | `?` | `const js = b2j.get(a[i]);` |
| 384 | `k` | `key` | `const k = (j2len.get(j - 1) ?? 0) + 1;` |
| 417 | `l` | `line` | `const candidates = oldLines.map((l) => l.trim()).filter(Boolean);` |
| 425 | `r` | `result` | `const r = ratio(anchor, stripped);` |

## packages/phantom-backend-sdk/src/git/sync.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 129 | `e` | `error` | `} catch (e) {` |
| 165 | `e` | `syncEvent` | `onEvent?: (e: SyncEvent) => void \| Promise<void>;` |
| 195 | `ev` | `?` | `const ev = async (step: SyncStep, detail?: string) => { await deps.onEvent?.({ step, label` |
| 223 | `e` | `error` | `.catch((e) => log.warn({ workspace: workspace.id, err: errStr(e) }, 'checkout lock renewal` |
| 226 | `e` | `error` | `.catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'lock renewal failed'));` |
| 275 | `e` | `error` | `} catch (e) {` |
| 304 | `e` | `error` | `await deps.recordSummary?.(session, project, blocked, opts).catch((e) =>` |
| 309 | `e` | `error` | `const ok = await deps.resolve(session, project, dir, ctx).catch((e) => {` |
| 359 | `e` | `error` | `await deps.recordSummary?.(session, project, done, opts).catch((e) =>` |
| 373 | `e` | `error` | `await deps.recordSummary?.(session, project, done, opts).catch((e) =>` |
| 384 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/api/routes/tasks.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 32 | `c` | `char` | `const c = deps.docker.getContainer(deps.sessionContainers.name(workspaceId));` |
| 59 | `e` | `error` | `} catch (e) {` |
| 65 | `r` | `row` | `const running = rows.filter((r) => r.status === 'running');` |
| 67 | `r` | `result` | `const bySid = new Map(running.filter((r) => r.sid).map((r) => [r.sid as string, r]));` |
| 67 | `r` | `result` | `const bySid = new Map(running.filter((r) => r.sid).map((r) => [r.sid as string, r]));` |
| 68 | `g` | `group` | `const tasks = groups.map((g) => {` |
| 89 | `t` | `target` | `const liveIds = new Set(tasks.map((t) => t.background_task_id).filter(Boolean));` |
| 91 | `r` | `result` | `.filter((r) => r.status !== 'running' && !liveIds.has(r.id))` |
| 93 | `r` | `result` | `.map((r) => ({` |
| 122 | `g` | `group` | `if (!groups.some((g) => g.sid === req.params.sid)) {` |
| 154 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 250));` |

## packages/phantom-backend-sdk/src/upgrade/updateTask.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 35 | `e` | `updateEvent` | `export type UpdateListener = (e: UpdateEvent) => void;` |
| 57 | `e` | `updateEvent` | `function emit(e: UpdateEvent) {` |
| 60 | `ev` | `?` | `current.events = current.events.filter((ev) => !(ev.event === 'pulling' && ev.image === e.` |
| 63 | `fn` | `?` | `for (const fn of current.listeners) {` |
| 73 | `e` | `event` | `for (const e of current.events) {` |
| 87 | `e` | `event` | `const pulled = current!.events.some((e) => e.event === 'pulled');` |
| 97 | `e` | `error` | `runUpdate(deps, tag).catch((e) => {` |
| 111 | `p` | `project` | `deps.images.pull(apiRef, (p) => emit({ event: 'pulling', image: 'api', ...p })),` |
| 112 | `p` | `project` | `deps.images.pull(sessionRef, (p) => emit({ event: 'pulling', image: 'session', ...p })),` |
| 171 | `r` | `wake` | `await new Promise((r) => setTimeout(r, 1000));` |
| 185 | `nl` | `?` | `let nl: number;` |

## phantom-backend/looper/logic.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 53 | `m` | `message` | `messages.filter((m) => m.role === 'user')` |
| 54 | `m` | `message` | `.map((m) => typeof m.content === 'string' ? m.content` |
| 55 | `p` | `project` | `: m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join` |
| 55 | `p` | `project` | `: m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join` |
| 60 | `t` | `target` | `return userTexts(messages).some((t) => t.startsWith(firstLine));` |
| 112 | `m` | `message` | `for (const m of messages) {` |
| 120 | `p` | `project` | `for (const p of m.content) {` |
| 137 | `t` | `target` | `.filter((t) => !t.terminal)` |
| 138 | `t` | `target` | `.map((t) => t.text \|\| NO_REPLY);` |
| 146 | `r` | `result` | `for (const r of received) if (i < sent.length && r === sent[i]) i++;` |
| 157 | `t` | `target` | `const has = (line: string) => supTexts.some((t) => t.startsWith(line));` |

## phantom-cli/screen.ts — 11

| line | old | new | the line |
|---|---|---|---|
| 31 | `e` | `record` | `function makeTracer(): ((e: Record<string, unknown>) => void) \| null {` |
| 36 | `e` | `error` | `return (e) => {` |
| 80 | `x` | `?` | `for (let x = x0; x <= x1 && x < term.cols; x++) {` |
| 82 | `ch` | `channel` | `const ch = cell?.getChars() ?? '';` |
| 106 | `r` | `result` | `for (const r of painted ?? []) seq += `\x1b[${r.y + 1};${r.x0 + 1}H\x1b[0m${cellText(r.y, ` |
| 107 | `r` | `result` | `for (const r of ranges ?? []) seq += `\x1b[${r.y + 1};${r.x0 + 1}H\x1b[0;7m${cellText(r.y,` |
| 109 | `r` | `result` | `painted = ranges ? ranges.map((r) => ({ ...r })) : null;` |
| 118 | `s` | `session` | `const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');` |
| 144 | `rs` | `?` | `textOf: (rs) => rs.map((r) => cellText(r.y, r.x0, r.x1).replace(/\s+$/, '')),` |
| 144 | `r` | `result` | `textOf: (rs) => rs.map((r) => cellText(r.y, r.x0, r.x1).replace(/\s+$/, '')),` |
| 145 | `rs` | `?` | `highlight: (rs) => {` |

## packages/phantom-backend-sdk/src/storage/tokenReport.ts — 10

| line | old | new | the line |
|---|---|---|---|
| 27 | `k` | `key` | `const k = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`` |
| 32 | `t` | `windowTotals` | `const pct = (t: WindowTotals) => t.input ? `${Math.round(t.cacheRead / t.input * 100)}%` :` |
| 37 | `r` | `reportRow` | `const modelName = (r: ReportRow) => (r.model ?? r.provider ?? '?').replace(/-\d{8}$/, '');` |
| 45 | `t` | `windowTotals` | `const line = (label: string, t: WindowTotals) =>` |
| 51 | `r` | `row` | `const live = rows.filter((r) => r[window].calls > 0);` |
| 54 | `h` | `header` | `''.padEnd(LABEL_W) + ['in', 'out', 'cache', 'calls'].map((h) => h.padStart(NUM_W)).join(''` |
| 55 | `r` | `result` | `line('total', live.reduce((a, r) => add(a, r[window]), ZERO)),` |
| 58 | `r` | `result` | `const mine = live.filter((r) => groupOf(r.type) === group)` |
| 60 | `r` | `result` | `out.push(line(`${group}s`, mine.reduce((a, r) => add(a, r[window]), ZERO)));` |
| 61 | `r` | `result` | `for (const r of mine) {` |

## packages/phantom-backend-sdk/src/runtime/Images.ts — 10

| line | old | new | the line |
|---|---|---|---|
| 26 | `m` | `match` | `const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);` |
| 75 | `e` | `pullEvent` | `see(e: PullEvent): boolean {` |
| 130 | `p` | `pullProgress` | `pull(image: string, onProgress?: (p: PullProgress) => void): Promise<void> {` |
| 133 | `p` | `project` | `const p = (this.removal ?? Promise.resolve())` |
| 141 | `p` | `pullProgress` | `private stream(image: string, onProgress?: (p: PullProgress) => void): Promise<void> {` |
| 143 | `e` | `error` | `this.docker.pull(image, (e: Error \| null, stream: NodeJS.ReadableStream) => {` |
| 177 | `r` | `result` | `.flatMap(({ repo, tag }) => { const r = releaseOf(tag); return r ? [{ repo, release: r }] ` |
| 181 | `c` | `char` | `const inUse = new Set((await this.docker.listContainers({ all: true })).map((c) => c.Image` |
| 189 | `c` | `char` | `if (live.some((c) => c.repo === repo && olderRelease(release, c.release))) stale.add(ref);` |
| 195 | `e` | `error` | `.catch((e) => log.warn({ image: tag, err: errStr(e) }, 'could not remove old image'));` |

## phantom-backend/crons/CronScheduler.ts — 10

| line | old | new | the line |
|---|---|---|---|
| 83 | `e` | `error` | `this.unsubscribe.push(this.backend.settingsEvents.subscribe((e) => {` |
| 91 | `u` | `usage` | `for (const u of this.unsubscribe) u();` |
| 93 | `r` | `result` | `for (const r of this.registered.values()) r.cron.stop();` |
| 102 | `e` | `error` | `.catch((e) => log.error({ project: projectId, err: errStr(e) }, 'cron reconcile failed'));` |
| 117 | `s` | `resolveManyResult` | `const s = await this.backend.settings.resolveMany(['cron_enabled', 'timezone'], { projectI` |
| 119 | `e` | `error` | `} catch (e) {` |
| 151 | `e` | `error` | `} catch (e) {` |
| 174 | `e` | `error` | `} catch (e) {` |
| 208 | `e` | `error` | `} catch (e) {` |
| 215 | `e` | `error` | `await agent.close().catch((e) => log.warn({ cron: row.name, err: errStr(e) }, 'cron sessio` |

## phantom-cli/commands.ts — 10

| line | old | new | the line |
|---|---|---|---|
| 21 | `c` | `choice` | `export const fillOf = (c: Choice) => c.fill ?? c.name;` |
| 74 | `m` | `match` | `const m = /^(\S*)(\s+([\s\S]*))?$/.exec(body);` |
| 93 | `c` | `char` | `if (!hasArgs) return { rows: COMMANDS.filter((c) => c.name.startsWith(head)) };` |
| 94 | `c` | `char` | `const command = COMMANDS.find((c) => c.name === head);` |
| 100 | `c` | `char` | `return { command, rows: choices(command).filter((c) => prefixed(c.name, args) \|\| prefixed(` |
| 107 | `c` | `char` | `const exact = COMMANDS.find((c) => c.name === head);` |
| 109 | `c` | `char` | `const partial = COMMANDS.filter((c) => c.name.startsWith(head));` |
| 111 | `c` | `char` | `if (partial.length > 1) return { error: `/${head} is ambiguous: ${partial.map((c) => `/${c` |
| 119 | `n` | `count` | `for (const n of names.slice(1)) {` |
| 140 | `m` | `message` | `const m = menu.rows;` |

## phantom-cli/screens.tsx — 10

| line | old | new | the line |
|---|---|---|---|
| 74 | `t` | `target` | `confirm={(t, m) => store.confirm(t, m)}` |
| 74 | `m` | `message` | `confirm={(t, m) => store.confirm(t, m)}` |
| 101 | `vs` | `?` | `const vs = store.voice.snapshot();` |
| 106 | `k` | `key` | `onOpenRow={(k) => { if (k === 'voice_mic_device' \|\| k === 'voice_speaker_device') void sto` |
| 137 | `t` | `target` | `confirm={(t, m) => store.confirm(t, m)}` |
| 137 | `m` | `message` | `confirm={(t, m) => store.confirm(t, m)}` |
| 173 | `t` | `target` | `onOpen={(t) => store.openArchivedCard(projectId, t)}` |
| 174 | `t` | `target` | `onRestore={(t) => { void store.restoreCard(projectId, t); }}` |
| 198 | `q` | `query` | `onQuery={which === 'resume' ? (q) => store.setPickerQuery(q) : undefined}` |
| 213 | `l` | `line` | `onPick={(l) => {` |

## packages/phantom-client-sdk/src/backend.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 69 | `nl` | `?` | `let nl: number;` |
| 88 | `o` | `backendOptions` | `constructor(o: BackendOptions) {` |
| 120 | `f` | `file` | `const f = opts.retry === false ? this.#fetch : this.#retrying;` |
| 126 | `e` | `error` | `} catch (e) {` |
| 134 | `r` | `result` | `const r = await this.#request(method, path, body, opts);` |
| 144 | `r` | `result` | `const r = await this.#request(method, path, body, opts);` |
| 152 | `r` | `result` | `const r = await this.#request(method, path, body, { ...opts, retry: false });` |
| 162 | `r` | `response` | `async #envelope<T>(r: Response, method: string, path: string): Promise<Envelope<T>> {` |
| 165 | `e` | `error` | `} catch (e) {` |

## packages/phantom-client-sdk/src/model/retry.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 27 | `s` | `session` | `retryable: (s) => s === 408 \|\| s === 409 \|\| s === 429 \|\| s >= 500,` |
| 35 | `s` | `session` | `retryable: (s) => s === 408 \|\| s === 429 \|\| s >= 500,` |
| 40 | `r` | `response` | `function serverDelayMs(r: Response, scheduledMs: number): number {` |
| 41 | `h` | `header` | `const h = r.headers.get('retry-after-ms') ?? r.headers.get('retry-after');` |
| 43 | `n` | `count` | `const n = parseFloat(h);` |
| 52 | `t` | `target` | `const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);` |
| 60 | `f` | `file` | `const f = inner ?? fetch;` |
| 66 | `r` | `response` | `let r: Response \| undefined;` |
| 70 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/git/GitService.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 67 | `e` | `autoPushEvent` | `onEvent?: (e: AutoPushEvent) => void \| Promise<void>, by?: string) => Promise<AutoPushResu` |
| 69 | `e` | `autoPullEvent` | `onEvent?: (e: AutoPullEvent) => void \| Promise<void>, by?: string) => Promise<AutoPullResu` |
| 112 | `e` | `syncEvent` | `return (e: SyncEvent) => this.deps.sessionEvents.publish(sessionId, by \|\| GIT_CLIENT_ID,` |
| 140 | `e` | `error` | `.catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'could not block card afte` |
| 153 | `r` | `result` | `const r = await autoPush({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onE` |
| 153 | `e` | `error` | `const r = await autoPush({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onE` |
| 162 | `r` | `result` | `const r = await autoPull({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onE` |
| 162 | `e` | `error` | `const r = await autoPull({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onE` |
| 174 | `e` | `error` | `.catch((e) => log.error({ err: errStr(e) }, 'instant sync reconcile threw'));` |

## packages/phantom-backend-sdk/src/api/routes/git.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 25 | `h` | `header` | `const h = req.headers['x-phantom-looper-client'];` |
| 54 | `e` | `error` | `} catch (e) { return send(reply, e); }` |
| 65 | `e` | `error` | `} catch (e) { return send(reply, e); }` |
| 75 | `e` | `error` | `} catch (e) { return send(reply, e); }` |
| 85 | `e` | `step` | `run: (onStep: (e: Step) => void) => Promise<Result>): Promise<FastifyReply> {` |
| 90 | `e` | `event` | `const result = await run((e) => write({ event: 'step', ...e }));` |
| 92 | `e` | `error` | `} catch (e) {` |
| 118 | `e` | `error` | `catch (e) { return send(reply, e); }` |
| 134 | `e` | `error` | `catch (e) { return send(reply, e); }` |

## packages/phantom-backend-sdk/src/runtime/Web.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 35 | `r` | `result` | `const r = await fetch(`${apiBase()}${route}`, {` |
| 47 | `s` | `session` | `const s = url.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9]+/g, '-')` |
| 60 | `r` | `record` | `let r: Record<string, any>;` |
| 67 | `x` | `record` | `const blocked = (x: Record<string, any>) => x.success &&` |
| 70 | `e` | `error` | `} catch (e) {` |
| 84 | `n` | `count` | `let name = urlSlug(url); let n = 2;` |
| 108 | `r` | `record` | `let r: Record<string, any>;` |
| 117 | `e` | `error` | `} catch (e) {` |
| 142 | `u` | `usage` | `return Promise.all(urls.map((u) => fetchOne(key, u, hostDir, taken)));` |

## phantom-backend/looper/Looper.ts — 9

| line | old | new | the line |
|---|---|---|---|
| 78 | `e` | `error` | `this.backend.settingsEvents.subscribe((e) => {` |
| 79 | `k` | `key` | `if (!e.keys.some((k) => k === 'auto_plan' \|\| k === 'auto_build')) return;` |
| 89 | `e` | `error` | `void this.runAllLoops().catch((e) => log.warn({ err: errStr(e) }, 'looper boot pass failed` |
| 109 | `e` | `error` | `} catch (e) {` |
| 127 | `e` | `error` | `catch (e) {` |
| 167 | `e` | `error` | `} catch (e) {` |
| 175 | `e` | `error` | `} catch (e) {` |
| 178 | `be` | `?` | `await this.blockCard(project, card.number, errStr(e)).catch((be) =>` |
| 335 | `t` | `sessionTotalsResult` | `const t = await this.backend.tokenLog.sessionTotals(sessionId);` |

## phantom-cli/components/NewProject.tsx — 9

| line | old | new | the line |
|---|---|---|---|
| 77 | `s` | `session` | `setStep((s) => s.at === 'working'` |
| 89 | `r` | `result` | `.then((r) => { if (live) setRepos(r as unknown as GitHubRepo[]); })` |
| 117 | `v` | `value` | `onSelect={(v) => setStep(v === 'create' ? { at: 'url', create: true } : { at: 'pick' })}` |
| 127 | `q` | `query` | `const q = query.trim().toLowerCase();` |
| 128 | `r` | `result` | `const shown = q ? repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q)) : ` |
| 129 | `r` | `result` | `const choices: Choice<Pick>[] = shown.map((r) => ({` |
| 141 | `r` | `result` | `if (typed && !repos.some((r) => `${r.owner}/${r.name}`.toLowerCase() === typed.toLowerCase` |
| 160 | `p` | `project` | `onSelect={(p) => {` |
| 186 | `v` | `value` | `onSubmit={(v) => {` |

## phantom-cli/components/ValueInput.tsx — 9

| line | old | new | the line |
|---|---|---|---|
| 75 | `c` | `char` | `choices={choices.map((c) => ({` |
| 80 | `v` | `value` | `onSelect={(v) => onSubmit(spec.type === 'boolean' ? v === 'true' : v)}` |
| 88 | `v` | `value` | `const v = raw.trim();` |
| 94 | `n` | `count` | `const n = parseMs(v);` |
| 98 | `n` | `count` | `const n = Number(v);` |
| 112 | `v` | `value` | `onChange={(v) => { setText(v); setError(undefined); }}` |
| 142 | `q` | `query` | `const q = query.trim().toLowerCase();` |
| 145 | `s` | `session` | `? all.filter((s) => s.toLowerCase().includes(q) \|\| labelOf(s).toLowerCase().includes(q))` |
| 148 | `s` | `session` | `const choices: Choice<string>[] = filtered.map((s) => {` |

## phantom-cli/components/Markdown.tsx — 9

| line | old | new | the line |
|---|---|---|---|
| 57 | `m` | `match` | `const m = full.match(/^(`+)([\s\S]+)\1$/);` |
| 120 | `th` | `?` | `const th = TABLE_ROW.exec(line);` |
| 126 | `r` | `row` | `const r = TABLE_ROW.exec(lines[i]);` |
| 164 | `ul` | `?` | `const ul = UL_ITEM.exec(line);` |
| 173 | `ol` | `?` | `const ol = OL_ITEM.exec(line);` |
| 261 | `l` | `line` | `for (const l of highlighted.split('\n')) parts.push(`${border} ${l}`);` |
| 272 | `n` | `count` | `const n = [...r];` |
| 290 | `c` | `char` | `for (let c = 0; c < numCols; c++) colW[c] = Math.max(3, Math.floor(colW[c] * scale));` |
| 311 | `r` | `row` | `for (const r of norm) out.push(fmtRow(r, false));` |

## phantom-cli/components/SecretEditor.tsx — 9

| line | old | new | the line |
|---|---|---|---|
| 41 | `d` | `secretDraft` | `onSave: (d: SecretDraft) => void;` |
| 61 | `n` | `count` | `const move = (d: number) => { atRef.current = (at + d + rows.length) % rows.length; bump((` |
| 64 | `d` | `data` | `const cycleWhere = (dir: 1 \| -1) => setDraft((d) => {` |
| 65 | `t` | `target` | `const i = targets.findIndex((t) => t.id === d.projectId);` |
| 71 | `d` | `data` | `const d = draftRef.current;` |
| 83 | `r` | `row` | `const r = rows[Math.min(atRef.current, rows.length - 1)];` |
| 106 | `v` | `value` | `onChange={(v) => { setError(undefined); setDraft((d) => ({ ...d, [k]: k === 'name' ? v.toU` |
| 106 | `d` | `data` | `onChange={(v) => { setError(undefined); setDraft((d) => ({ ...d, [k]: k === 'name' ? v.toU` |
| 112 | `t` | `target` | `const whereLabel = targets.find((t) => t.id === draft.projectId)?.label ?? 'global — every` |

## packages/phantom-client-sdk/src/turn.ts — 8

| line | old | new | the line |
|---|---|---|---|
| 133 | `st` | `state` | `const st: { pendingMessages: ModelMessage[]; recordFailure: PhantomError \| null } =` |
| 143 | `l` | `line` | `for (const l of lines) if (l.type === 'message') tally.added.push(l.message);` |
| 144 | `e` | `error` | `} catch (e) {` |
| 179 | `e` | `error` | `onLanguageModelCallEnd: async (e) => {` |
| 182 | `u` | `usage` | `const u = {` |
| 215 | `p` | `project` | `const p = part as ToolResult;` |
| 230 | `e` | `error` | `} catch (e) {` |
| 254 | `c` | `char` | `for (const c of step.calls) if (!step.answered.has(c.toolCallId)) lines.push(messageLine(i` |

## packages/phantom-backend-sdk/src/telegram/sink.ts — 8

| line | old | new | the line |
|---|---|---|---|
| 139 | `m` | `sendMessageResult` | `const m = await client.sendMessage(chatId, THINKING_DOTS[0]);` |
| 199 | `m` | `sendMessageResult` | `if (messageId == null) { const m = await client.sendMessage(chatId, body, { entities }); m` |
| 218 | `m` | `sendMessageResult` | `else { const m = await client.sendMessage(chatId, line); mid = m?.message_id ?? null; }` |
| 228 | `p` | `record` | `function part(p: Record<string, unknown>) {` |
| 284 | `m` | `sendMessageResult` | `else { const m = await client.sendMessage(chatId, chunks[0].text, { entities: chunks[0].en` |
| 285 | `c` | `char` | `for (const c of chunks.slice(1)) await client.sendMessage(chatId, c.text, { entities: c.en` |
| 296 | `f` | `file` | `for (const f of files) {` |
| 299 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/git/InstantSync.ts — 8

| line | old | new | the line |
|---|---|---|---|
| 101 | `c` | `configOfResult` | `const c = await this.configOf(project);` |
| 119 | `r` | `row` | `for (const id of new Set(rows.map((r) => r.projectId))) {` |
| 126 | `c` | `char` | `const c = configs.get(row.projectId);` |
| 136 | `e` | `error` | `.catch((e) => log.warn({ workspace: row.id, err: errStr(e) }, 'could not start watching'))` |
| 150 | `c` | `resolveManyResult` | `const c = await this.deps.settings.resolveMany(` |
| 155 | `c` | `config` | `private async attach(workspaceId: string, project: ProjectRow, c: Config): Promise<void> {` |
| 197 | `e` | `error` | `} catch (e) {` |
| 206 | `r` | `autoPushResult` | `r: AutoPushResult \| AutoPullResult): void {` |

## core/agents/assistant/handlers.ts — 8

| line | old | new | the line |
|---|---|---|---|
| 108 | `e` | `error` | `} catch (e) {` |
| 117 | `s` | `session` | `sessions: page.map((s) => ({` |
| 164 | `e` | `error` | `} catch (e) {` |
| 195 | `e` | `error` | `} catch (e) { return { error: (e as Error).message }; }` |
| 210 | `e` | `error` | `catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }` |
| 216 | `e` | `error` | `catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }` |
| 225 | `d` | `data` | `let d: { service: string; text: string; truncated?: boolean };` |
| 227 | `e` | `error` | `catch (e) { return { error: (e as Error).message }; }` |

## phantom-cli/selfUpdate.ts — 8

| line | old | new | the line |
|---|---|---|---|
| 77 | `m` | `match` | `const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());` |
| 89 | `m` | `match` | `const scratchPid = (name: string): number \| null => { const m = /^\.[a-z]+-(\d+)/.exec(nam` |
| 105 | `n` | `count` | `return names.filter((n) => !n.startsWith('.') && existsSync(join(appRoot, n, 'VERSION')));` |
| 109 | `e` | `error` | `try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)` |
| 145 | `v` | `value` | `for (const v of installedVersions(appRoot)) if (!keep.has(v)) drop(v);` |
| 148 | `n` | `count` | `for (const n of names) {` |
| 247 | `e` | `error` | `} catch (e) {` |
| 251 | `r` | `result` | `const r = installVersion(staged, { appRoot, launcher: opts.launcher });` |

## phantom-cli/components/Keys.tsx — 8

| line | old | new | the line |
|---|---|---|---|
| 50 | `e` | `error` | `} catch (e) { setNotice(`could not load: ${(e as Error).message}`); setCreds([]); }` |
| 60 | `e` | `error` | `.catch((e: Error) => setNotice(e.message))` |
| 70 | `r` | `result` | `const r = await api('GET', '/github/whoami') as { login?: string };` |
| 72 | `e` | `error` | `} catch (e) {` |
| 86 | `v` | `value` | `onSubmit={(v) => {` |
| 106 | `n` | `count` | `onSelect={(n) => { setLast(n); setEditing(n); }}` |
| 108 | `ch` | `channel` | `onKey={(ch, n) => {` |
| 108 | `n` | `count` | `onKey={(ch, n) => {` |

## packages/phantom-client-sdk/src/transcript.ts — 7

| line | old | new | the line |
|---|---|---|---|
| 41 | `u` | `tokenUsage` | `export const usageLine = (u: TokenUsage): UsageLine => ({ type: 'usage', id: lineId(), at:` |
| 53 | `m` | `message` | `const m = messages[i]!;` |
| 56 | `c` | `char` | `const rest = m.content.filter((c) => c.type !== 'text');` |
| 57 | `c` | `char` | `const at = m.content.findIndex((c) => c.type === 'text');` |
| 68 | `l` | `line` | `for (const l of lines) {` |
| 77 | `t` | `tokenTotals` | `const t: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };` |
| 78 | `l` | `line` | `for (const l of lines) {` |

## packages/phantom-client-sdk/src/session.ts — 7

| line | old | new | the line |
|---|---|---|---|
| 64 | `e` | `error` | `private constructor(private readonly backend: BackendClient, private readonly handlers: { ` |
| 72 | `e` | `error` | `static async load(backend: BackendClient, handlers: { onError(e: PhantomError): void }, se` |
| 102 | `e` | `error` | `catch (e) { this.handlers.onError(asPhantomError(e, 'internal', 'ending the turn')); }` |
| 114 | `c` | `char` | `if (cut.length) await this.append(cut.map((c) => messageLine(interruptedResultMessage(c)))` |
| 123 | `l` | `line` | `for (const l of lines) {` |
| 142 | `m` | `message` | `const m = messages[i]!;` |
| 144 | `p` | `project` | `for (const p of m.content) if (p.type === 'tool-result') answered.add(p.toolCallId);` |

## packages/phantom-backend-sdk/src/api/routes/kanban.ts — 7

| line | old | new | the line |
|---|---|---|---|
| 21 | `h` | `header` | `const h = req.headers['x-phantom-looper-client'];` |
| 58 | `f` | `file` | `for (const f of [...CARD_FIELDS, ...CARD_JSON_FIELDS]) {` |
| 91 | `s` | `session` | `return (await ctx.sessions.codersByCard(project.id)).map((s) => ({` |
| 125 | `cs` | `?` | `const cs = await cardSessions(project);` |
| 130 | `c` | `card` | `for (const c of cs) { if (c.workState) cardWorkState[c.card] = c.workState; if (c.locked) ` |
| 148 | `e` | `error` | `catch (e) { return cardErr(reply, e); }` |
| 166 | `e` | `error` | `catch (e) { return cardErr(reply, e); }` |

## packages/phantom-backend-sdk/src/runtime/Skills.ts — 7

| line | old | new | the line |
|---|---|---|---|
| 48 | `e` | `error` | `for (const e of entries) {` |
| 49 | `r` | `result` | `const r = rel ? `${rel}/${e.name}` : e.name;` |
| 63 | `mk` | `runResult` | `const mk = await sandbox.run(['mkdir', '-p', dir]);` |
| 122 | `e` | `error` | `} catch (e) {` |
| 174 | `r` | `result` | `const r = fuzzyFindAndReplace(current, body.old_string, body.new_string, body.replace_all ` |
| 188 | `r` | `runResult` | `const r = await sandbox.run(['rm', '-rf', skillDirContainer(name)]);` |
| 211 | `r` | `runResult` | `const r = await sandbox.run(['rm', '-f', `${skillDirContainer(name)}/${body.file_path}`]);` |

## core/agents/assistant/tools.ts — 7

| line | old | new | the line |
|---|---|---|---|
| 157 | `m` | `message` | `for (const m of messages.slice(start, end)) lines.push(...renderMessage(m, opts.tools === ` |
| 171 | `o` | `options` | `const o = input as Record<string, unknown>;` |
| 175 | `v` | `value` | `for (const v of Object.values(o)) if (typeof v === 'string') return oneLine(v);` |
| 184 | `m` | `modelMessage` | `function renderMessage(m: ModelMessage, fullTools: boolean): string[] {` |
| 187 | `p` | `project` | `return m.content.map((p) => p.type === 'text' ? `user: ${p.text}` : `user: [${p.type}]`);` |
| 192 | `p` | `project` | `for (const p of m.content) {` |
| 200 | `p` | `project` | `return m.content.map((p) => {` |

## phantom-cli/components/Toolbar.tsx — 7

| line | old | new | the line |
|---|---|---|---|
| 50 | `g` | `group` | `.map((g) => g.filter((p) => (typeof p === 'string' ? p : p.text)))` |
| 50 | `p` | `project` | `.map((g) => g.filter((p) => (typeof p === 'string' ? p : p.text)))` |
| 51 | `g` | `group` | `.filter((g) => g.length);` |
| 60 | `g` | `group` | `{shown.map((g, gi) => (` |
| 60 | `gi` | `?` | `{shown.map((g, gi) => (` |
| 63 | `p` | `project` | `{g.map((p, pi) => (` |
| 63 | `pi` | `?` | `{g.map((p, pi) => (` |

## packages/phantom-client-sdk/src/backendConnection.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 25 | `o` | `backendConnectionOptions` | `constructor(o: BackendConnectionOptions) {` |
| 34 | `s` | `session` | `const s = http2.connect(this.origin, this.#ca ? { ca: this.#ca } : {});` |
| 51 | `v` | `value` | `new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });` |
| 51 | `k` | `key` | `new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });` |
| 64 | `e` | `error` | `req.on('error', (e: Error) => {` |
| 69 | `h` | `header` | `req.on('response', (h) => {` |

## packages/phantom-backend-sdk/src/tools/diff.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 9 | `n` | `count` | `const n = a.length, m = b.length;` |
| 18 | `dp` | `uint` | `const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));` |
| 53 | `k` | `key` | `for (let k = 0; k < ops.length; k++) {` |
| 54 | `op` | `?` | `const op = ops[k];` |
| 71 | `o` | `options` | `lines: back.map((o) => ` ${aLines[o.aIndex!]}`),` |
| 82 | `h` | `header` | `for (const h of hunks) {` |

## packages/phantom-backend-sdk/src/telegram/entities.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 249 | `e` | `error` | `for (const e of entities) {` |
| 251 | `to` | `?` | `const to = Math.min(e.offset + e.length, end);` |
| 262 | `f` | `formatted` | `export function truncateFormatted(f: Formatted, limit: number): Formatted {` |
| 279 | `f` | `formatted` | `export function splitFormatted(f: Formatted, limit = 4096): Formatted[] {` |
| 305 | `n` | `count` | `const n = chunks.length;` |
| 307 | `c` | `char` | `return chunks.map((c, i) => ({ ...c, text: `${c.text}\n\n(${i + 1}/${n})` }));` |

## packages/phantom-backend-sdk/src/git/GitHub.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 22 | `me` | `?` | `const me = await fetch(`${apiBase()}/user`, { headers: headers(pat) });` |
| 28 | `e` | `error` | `} catch (e) {` |
| 45 | `me` | `?` | `const me = await fetch(`${apiBase()}/user`, { headers: headers(pat) });` |
| 73 | `e` | `error` | `} catch (e) {` |
| 103 | `r` | `result` | `for (const r of batch) {` |
| 110 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/api/routes/dbUi.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 51 | `r` | `result` | `const r = await fetch(`${base}${DB_UI_PREFIX}/api/gql`, {` |
| 68 | `q` | `query` | `const q = (query: string, variables?: unknown) => JSON.stringify({ query, variables });` |
| 72 | `u` | `usage` | `const u = new URL(dsn);` |
| 143 | `e` | `error` | `bootstrapped = bootstrap(base, process.env.DB_UI_DSN).catch((e) => {` |
| 177 | `e` | `error` | `} catch (e) {` |
| 236 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/api/routes/secrets.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 43 | `sc` | `?` | `const sc = await scopesOf(req.query);` |
| 48 | `s` | `session` | `const secrets = raw.map((s) => ({` |
| 76 | `sc` | `?` | `const sc = await scopesOf(req.query);` |
| 93 | `sc` | `?` | `const sc = await scopesOf(req.query);` |
| 98 | `s` | `session` | `const names = (await ctx.settings.listSecrets(sc.chain)).map((s) => s.name);` |
| 111 | `sc` | `?` | `const sc = await scopesOf(req.query);` |

## packages/phantom-backend-sdk/src/api/routes/projects.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 14 | `r` | `projectRow` | `function publicProject(r: ProjectRow, hasCredential = false) {` |
| 70 | `r` | `result` | `return ok(listed.repos.map((r) => ({ ...r, added: have.has(`${r.owner}/${r.name}`.toLowerC` |
| 77 | `r` | `row` | `return ok(await Promise.all(rows.map(async (r) => ({` |
| 114 | `e` | `error` | `} catch (e) { return reply.code(400).send(err('invalid_url', (e as Error).message)); }` |
| 143 | `e` | `error` | `} catch (e) {` |
| 165 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/upgrade/UpgradeChecker.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 111 | `p` | `project` | `const p = this.pending;` |
| 143 | `v` | `value` | `const v = bare(tag);` |
| 146 | `m` | `sendMarkdownResult` | `const m = await client.sendMarkdown(dm, titled(`⬆️ ${v} is available — you're on ${current` |
| 160 | `p` | `pending` | `private async doUpgrade(client: TelegramApi, dm: number, p: Pending): Promise<void> {` |
| 162 | `v` | `value` | `const v = bare(tag);` |
| 179 | `r` | `triggerUpdateResult` | `const r = await this.deps.triggerUpdate(tag, (event) => {` |

## packages/phantom-backend-sdk/src/storage/Crons.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 57 | `c` | `char` | `const c = new Cron(schedule, { timezone });` |
| 67 | `e` | `error` | `catch (e) {` |
| 88 | `l` | `line` | `return () => { this.listeners = this.listeners.filter((l) => l !== fn); };` |
| 91 | `l` | `line` | `for (const l of this.listeners) l(projectId);` |
| 141 | `e` | `error` | `} catch (e) {` |
| 168 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/lib/crypto.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 9 | `ab` | `?` | `const ab = Buffer.from(a); const bb = Buffer.from(b);` |
| 9 | `bb` | `?` | `const ab = Buffer.from(a); const bb = Buffer.from(b);` |
| 15 | `iv` | `?` | `const iv = randomBytes(12);` |
| 17 | `ct` | `?` | `const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);` |
| 22 | `iv` | `?` | `const iv = blob.subarray(0, 12);` |
| 24 | `ct` | `?` | `const ct = blob.subarray(28);` |

## phantom-backend/notifications/digest.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 88 | `e` | `error` | `this.run().catch((e) => log.warn({ err: (e as Error).message }, 'digest tick failed'))` |
| 109 | `r` | `row` | `const wsIds = [...new Set(rows.map((r) => r.projectId))];` |
| 127 | `s` | `session` | `for (const s of rows) {` |
| 190 | `ch` | `channel` | `for (const ch of this.backend.notifications.channels()) {` |
| 191 | `e` | `error` | `await ch.send(message).catch((e) =>` |
| 197 | `s` | `session` | `for (const s of rows) await this.backend.sessions.markDigested(s.id, now);` |

## core/sessionRows.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 44 | `s` | `pick` | `export function whoDrives(s: Pick<SessionRow, 'agent' \| 'startedBy' \| 'lastTurnBy'>): Driv` |
| 56 | `s` | `sessionRow` | `export function isRunning(s: SessionRow,` |
| 64 | `s` | `session` | `const s = Math.max(0, (now - Date.parse(iso)) / 1000);` |
| 66 | `m` | `message` | `const m = s / 60;` |
| 68 | `h` | `header` | `const h = m / 60;` |
| 70 | `d` | `data` | `const d = Math.round(h / 24);` |

## phantom-cli/autoUpdate.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 35 | `t` | `target` | `const t = Number(readOverrides(path).overrides[STAMP_KEY]);` |
| 69 | `d` | `autoUpdateDeps` | `export async function autoUpdateCycle(d: AutoUpdateDeps): Promise<CycleResult> {` |
| 78 | `e` | `error` | `} catch (e) {` |
| 116 | `d` | `reconcileDeps` | `export async function prelaunchReconcile(d: ReconcileDeps): Promise<void> {` |
| 118 | `h` | `raceResult` | `const h = await Promise.race([` |
| 124 | `me` | `?` | `const me = bare(d.appVersion);` |

## phantom-cli/local.ts — 6

| line | old | new | the line |
|---|---|---|---|
| 30 | `e` | `error` | `catch (e) { return { overrides: {}, error: `settings file is not valid JSON — using defaul` |
| 37 | `v` | `value` | `const v = env[name];` |
| 52 | `r` | `resolved` | `let r: Resolved = { value: DEFAULTS[key] as ConfigValue, source: 'default' };` |
| 54 | `e` | `error` | `const e = envValue(key, env);` |
| 56 | `v` | `configValue` | `const v: ConfigValue = META[key].type === 'number' ? Number(e.value)` |
| 70 | `k` | `key` | `LOCAL_KEYS.map((k) => [k, config[k].value]),` |

## packages/phantom-backend-sdk/src/api/routes/settings.ts — 5

| line | old | new | the line |
|---|---|---|---|
| 52 | `sc` | `?` | `const sc = await scopeOf(req.query);` |
| 81 | `sc` | `?` | `const sc = await scopeOf(req.query);` |
| 86 | `e` | `error` | `} catch (e) {` |
| 102 | `sc` | `?` | `const sc = await scopeOf(req.query);` |
| 106 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/storage/schema.ts — 5

| line | old | new | the line |
|---|---|---|---|
| 19 | `v` | `value` | `toDriver: (v) => JSON.stringify(v),` |
| 20 | `v` | `value` | `fromDriver: (v) => v,` |
| 39 | `t` | `target` | `}, (t) => [primaryKey({ columns: [t.scope, t.namespace, t.key] })]);` |
| 81 | `t` | `target` | `}, (t) => [unique().on(t.project_id, t.number)]);` |
| 251 | `t` | `target` | `}, (t) => [primaryKey({ columns: [t.chatId, t.messageId] })]);` |

## packages/phantom-backend-sdk/src/runtime/SystemSkills.ts — 5

| line | old | new | the line |
|---|---|---|---|
| 43 | `e` | `error` | `} catch (e) {` |
| 52 | `e` | `error` | `} catch (e) {` |
| 93 | `ex` | `?` | `const ex = extract();` |
| 104 | `d` | `buffer` | `content.on('data', (d: Buffer) => { chunks.push(d); total += d.length; });` |
| 107 | `s` | `session` | `let s = tree.get(skill);` |

## phantom-cli/components/TextInput.tsx — 5

| line | old | new | the line |
|---|---|---|---|
| 64 | `gw` | `?` | `const gw = stringWidth(segment);` |
| 86 | `gw` | `?` | `const gw = stringWidth(segment);` |
| 162 | `r` | `row` | `const rowIdx = rows.findIndex((r) => cursor >= r.start && cursor <= r.end` |
| 232 | `v` | `value` | `const v = valueRef.current;` |
| 233 | `c` | `char` | `const c = cursorRef.current;` |

## phantom-cli/components/SessionSwitcher.tsx — 5

| line | old | new | the line |
|---|---|---|---|
| 19 | `s` | `pick` | `export function lastSaid(s: Pick<LoadedSession, 'history'>): string \| undefined {` |
| 21 | `m` | `message` | `const m = s.history[i];` |
| 26 | `c` | `char` | `? m.content.filter((c) => (c as { type?: string }).type === 'text')` |
| 27 | `c` | `char` | `.map((c) => (c as { text?: string }).text ?? '').join('')` |
| 41 | `s` | `session` | `return sessions.map((s) => {` |

## packages/phantom-client-sdk/src/feed.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 60 | `e` | `error` | `} catch (e) {` |
| 82 | `l` | `feedListener` | `constructor(backend: BackendClient, sessionId: string, opening: { agent: string; message: ` |
| 95 | `l` | `feedListener` | `function watchSession(backend: BackendClient, sessionId: string, l: FeedListener, onFailed` |
| 103 | `e` | `error` | `} catch (e) {` |

## packages/phantom-client-sdk/src/record.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 38 | `r` | `result` | `const r = await backend.call<TranscriptReply>('GET', `/sessions/${sessionId}/transcript`);` |
| 50 | `r` | `result` | `const r = await this.backend.call<TranscriptReply>('GET',` |
| 77 | `r` | `result` | `let r: { lines: number; applied: boolean; updated_at: string };` |
| 80 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/prompt/template.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 29 | `v` | `value` | `const v = vars[name];` |
| 34 | `m` | `message` | `const names = [...line.matchAll(token())].map((m) => m[1]);` |
| 35 | `n` | `count` | `return !names.length \|\| names.some((n) => val(n) !== '');` |
| 49 | `l` | `line` | `const line = template.split('\n').find((l) => l.trim() !== '') ?? '';` |

## packages/phantom-backend-sdk/src/tools/board.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 14 | `t` | `cardRow` | `const renderCard = (t: CardRow) => ({ card: t.number, title: t.title, status: t.status, de` |
| 20 | `e` | `error` | `catch (e) {` |
| 73 | `t` | `byNumberResult` | `const t = await ctx.app.cards.byNumber(ctx.project, Number(a.card));` |
| 89 | `c` | `card` | `cards: cards.map((c) => ({ card: c.number, title: c.title, status: c.status })) };` |

## packages/phantom-backend-sdk/src/telegram/TelegramApi.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 86 | `r` | `wake` | `await new Promise((r) => setTimeout(r, wait));` |
| 140 | `m` | `callResult` | `const m = await this.call('sendMessage', {` |
| 164 | `r` | `callResult` | `const r = await this.call('editMessageText', {` |
| 173 | `r` | `callResult` | `const r = await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });` |

## packages/phantom-backend-sdk/src/telegram/transcriptHelper.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 8 | `l` | `line` | `for (const l of parseLines(text)) {` |
| 10 | `c` | `char` | `const c = l.message.content;` |
| 11 | `t` | `target` | `const t = typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join` |
| 11 | `p` | `project` | `const t = typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join` |

## packages/phantom-backend-sdk/src/telegram/TelegramVoice.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 37 | `e` | `error` | `} catch (e) {` |
| 97 | `re` | `?` | `const re = new RegExp(SENTENCE_END.source, 'g');` |
| 99 | `m` | `message` | `for (const m of text.matchAll(re)) out.push(m.index + m[0].length);` |
| 118 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/agents/SystemPrompt.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 58 | `e` | `error` | `catch (e) {` |
| 82 | `s` | `session` | `return fill(SKILLS_LIST, { skillsList: skills.map((s) => `- ${s.name}: ${clip(s.descriptio` |
| 93 | `s` | `session` | `return fill(SECRETS_LIST, { secretsList: secrets.map((s) => `- ${s.name}: ${clip(s.descrip` |
| 137 | `p` | `project` | `assembled[section] = parts.filter((p) => p !== '').join('\n\n');` |

## phantom-backend/telegram/assistant.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 35 | `c` | `cardRow` | `const cardOf = (c: CardRow) => ({ card: c.number, title: c.title, status: c.status });` |
| 56 | `k` | `key` | `for (const k of ['details', 'status'] as const) if (args[k] !== undefined) body[k] = args[` |
| 62 | `k` | `key` | `for (const k of ['title', 'details', 'status', 'blocked_reason',` |
| 75 | `e` | `error` | `} catch (e) { return { error: (e as Error).message }; }` |

## phantom-backend/api/routes/system.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 46 | `p` | `project` | `const p = req.query.provider ?? '';` |
| 83 | `e` | `error` | `catch (e) {` |
| 118 | `e` | `error` | `catch (e) { return systemErr(reply, e); }` |
| 149 | `e` | `error` | `catch (e) { return systemErr(reply, e); }` |

## phantom-cli/request.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 15 | `e` | `error` | `export function requestError(method: string, path: string, base: string, e: PhantomError):` |
| 58 | `e` | `error` | `} catch (e) {` |
| 64 | `r` | `result` | `const r = await api(method, path, body);` |
| 67 | `e` | `error` | `} catch (e) {` |

## phantom-cli/settingLabels.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 64 | `v` | `value` | `const v = input.trim();` |
| 65 | `m` | `match` | `const m = v.match(/^(\d+(?:\.\d+)?)\s*([dhms])$/i);` |
| 67 | `n` | `count` | `const n = Number(m[1]);` |
| 72 | `n` | `count` | `const n = Number(v);` |

## phantom-cli/server.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 30 | `l` | `line` | `const l = localValues();` |
| 55 | `e` | `error` | `catch (e) { throw isPhantomError(e) ? requestError(method, path, base, e) : e; }` |
| 62 | `it` | `?` | `const it = this.backend().stream('GET', path, undefined, { signal });` |
| 91 | `e` | `error` | `} catch (e) { throw isPhantomError(e) ? requestError('POST', `/git/${route}`, base, e) : e` |

## phantom-cli/mouse.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 39 | `m` | `match` | `const m = SGR.exec(input);` |
| 42 | `x` | `?` | `const x = Number(m[2]) - 1;` |
| 43 | `y` | `?` | `const y = Number(m[3]) - 1;` |
| 89 | `y` | `?` | `for (let y = a.y; y <= b.y; y++) {` |

## phantom-cli/components/table.ts — 4

| line | old | new | the line |
|---|---|---|---|
| 49 | `c` | `cell` | `const cellOf = (c: Cell \| undefined): { text: string; mark?: string; markChar?: string; ma` |
| 52 | `c` | `cell` | `const cellWidth = (c: Cell \| undefined): number => {` |
| 58 | `c` | `cell` | `const column = (c: Cell \| undefined, width: number \| undefined): Column => {` |
| 69 | `c` | `char` | `const widths = cols.map((c, i) => {` |

## phantom-cli/components/Pane.tsx — 4

| line | old | new | the line |
|---|---|---|---|
| 83 | `v` | `value` | `setVersion((v) => v + 1);` |
| 98 | `h` | `header` | `const h = map.get(key(i));` |
| 116 | `h` | `header` | `const h = rowsAt(end);` |
| 144 | `k` | `key` | `const k = key(i);` |

## phantom-cli/components/Screen.tsx — 4

| line | old | new | the line |
|---|---|---|---|
| 38 | `k` | `key` | `keys.filter((k) => k.when !== false).map((k) => `[${k.key}] ${k.does}`).join(' · ');` |
| 38 | `k` | `key` | `keys.filter((k) => k.when !== false).map((k) => `[${k.key}] ${k.does}`).join(' · ');` |
| 58 | `k` | `key` | `const visible = keys.filter((k) => k.when !== false);` |
| 59 | `k` | `key` | `return visible.map((k, i) => {` |

## packages/phantom-client-sdk/src/events.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 29 | `fn` | `listener` | `on<E extends keyof AgentEvents>(event: E, fn: Listener<AgentEvents[E]>): () => void {` |
| 41 | `fn` | `?` | `for (const fn of [...set]) {` |
| 43 | `e` | `error` | `catch (e) { onListenerError(e); }` |

## packages/phantom-backend-sdk/src/tools/git.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 31 | `e` | `error` | `catch (e) {` |
| 47 | `t` | `target` | `const t = await target(ctx, a);` |
| 60 | `t` | `target` | `const t = await target(ctx, a);` |

## packages/phantom-backend-sdk/src/tools/skills.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 29 | `d` | `data` | `const d = deps(ctx);` |
| 46 | `d` | `data` | `const d = deps(ctx);` |
| 79 | `d` | `data` | `const d = deps(ctx);` |

## packages/phantom-backend-sdk/src/git/workRefresh.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 30 | `f` | `file` | `await Promise.all(stale.map(async (f) => {` |
| 45 | `f` | `file` | `await Promise.all(rows.map(async (f) => {` |
| 52 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/api/routes/crons.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 35 | `f` | `file` | `for (const f of CRON_FIELDS) {` |
| 73 | `e` | `error` | `catch (e) { return cronErr(reply, e); }` |
| 86 | `e` | `error` | `catch (e) { return cronErr(reply, e); }` |

## packages/phantom-backend-sdk/src/api/routes/skills.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 41 | `e` | `error` | `} catch (e) { return handle(reply, e); }` |
| 55 | `e` | `error` | `} catch (e) { return handle(reply, e); }` |
| 75 | `e` | `error` | `} catch (e) { return handle(reply, e); }` |

## packages/phantom-backend-sdk/src/agents/SessionEvents.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 111 | `e` | `sessionEvent` | `publish(sessionId: string, by: string, e: SessionEvent): void {` |
| 120 | `e` | `sessionEvent` | `subscribe(sessionId: string, fn: (e: SessionEvent, by: string) => void): () => void {` |
| 126 | `e` | `sessionEvent` | `subscribeAll(fn: (sessionId: string, e: SessionEvent, by: string) => void): () => void {` |

## packages/phantom-backend-sdk/src/agents/BoardEvents.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 35 | `e` | `boardEvent` | `publish(projectId: string, e: BoardEvent): void {` |
| 39 | `e` | `boardEvent` | `subscribe(projectId: string, fn: (e: BoardEvent) => void): () => void {` |
| 46 | `e` | `boardEvent` | `subscribeAll(fn: (projectId: string, e: BoardEvent) => void): () => void {` |

## packages/phantom-backend-sdk/src/agents/ForegroundCommands.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 33 | `e` | `error` | `.catch((e) => log.warn({ err: errStr(e) }, 'kill of command group failed'));` |
| 43 | `m` | `message` | `let m = this.bySession.get(sessionId);` |
| 49 | `m` | `message` | `const m = this.bySession.get(sessionId);` |

## packages/phantom-backend-sdk/src/storage/Workspaces.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 114 | `e` | `error` | `} catch (e) {` |
| 129 | `e` | `error` | `} catch (e) {` |
| 204 | `r` | `row` | `return rows.map((r) => r.id);` |

## packages/phantom-backend-sdk/src/lib/clock.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 15 | `z` | `?` | `export const TIMEZONES: readonly string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').` |
| 23 | `n` | `count` | `const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);` |
| 23 | `p` | `project` | `const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);` |

## phantom-backend/index.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 56 | `e` | `error` | `} catch (e) {` |
| 115 | `e` | `error` | `await telegram.upgradeChecker.check().catch((e) => log.warn({ err: errStr(e) }, 'upgrade c` |
| 148 | `e` | `error` | `main().catch((e) => { log.error({ err: errStr(e) }, 'boot failed'); process.exit(1); });` |

## core/prompts/autoPush/wiring.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 8 | `l` | `line` | `(lines.length ? lines : [empty]).map((l) => `- ${l}`).join('\n');` |
| 31 | `l` | `line` | `if (arrived.length) parts.push(arrived.map((l) => `- ${l}`).join('\n'));` |
| 44 | `l` | `line` | `if (arrived.length) parts.push(arrived.map((l) => `- ${l}`).join('\n'));` |

## phantom-cli/drop.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 22 | `c` | `char` | `const c = text[i];` |
| 43 | `u` | `uRL` | `let u: URL;` |
| 58 | `p` | `project` | `const p = asLocalPath(word);` |

## phantom-cli/keys.tsx — 3

| line | old | new | the line |
|---|---|---|---|
| 15 | `k` | `key` | `'backspace', 'delete', 'pageUp', 'pageDown', 'home', 'end'] as const).find((k) => key[k]);` |
| 18 | `l` | `line` | `setLines((l) => [...l.slice(-14), label]);` |
| 24 | `l` | `line` | `{lines.map((l, i) => <Text key={i}>{`  ${l}`}</Text>)}` |

## phantom-cli/config.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 115 | `m` | `message` | `const m = META[key];` |
| 127 | `v` | `configValue` | `export function mask(v: ConfigValue): string {` |
| 129 | `s` | `session` | `const s = String(v);` |

## phantom-cli/cursorAudit.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 111 | `m` | `match` | `const m = CPR.exec(tail);` |
| 127 | `pt` | `?` | `const pt = new PassThrough();` |
| 136 | `r` | `result` | `for (const r of replies) onCpr(r);` |

## phantom-cli/assistantKit.ts — 3

| line | old | new | the line |
|---|---|---|---|
| 37 | `n` | `count` | `const project = this.rows.find((n) => n.id === id);` |
| 59 | `h` | `header` | `history: (id) => { const h = store.get(id)?.history; return h ? [...h] : null; },` |
| 109 | `up` | `?` | `const up = win.boardUp;` |

## phantom-cli/components/Archived.tsx — 3

| line | old | new | the line |
|---|---|---|---|
| 50 | `t` | `target` | `onSelect={(t) => { if (t) onOpen(t); }}` |
| 52 | `ch` | `channel` | `onKey={(ch, t) => { if (ch === 'r' && t) onRestore(t); }}` |
| 52 | `t` | `target` | `onKey={(ch, t) => { if (ch === 'r' && t) onRestore(t); }}` |

## packages/phantom-client-sdk/src/systemPrompt.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 32 | `p` | `storedSystemPrompt` | `export const systemPromptBlocks = (p: StoredSystemPrompt): string[] =>` |
| 33 | `s` | `session` | `SYSTEM_PROMPT_SECTIONS.map((s) => p[s]).filter((text) => text.trim() !== '');` |

## packages/phantom-client-sdk/src/version.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 9 | `m` | `match` | `const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());` |
| 32 | `r` | `result` | `const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {` |

## packages/phantom-client-sdk/src/toolkit.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 111 | `t` | `tool` | `return Promise.resolve({ tools: out, mutating: listing.filter((t) => t.mutates).map((t) =>` |
| 111 | `t` | `tool` | `return Promise.resolve({ tools: out, mutating: listing.filter((t) => t.mutates).map((t) =>` |

## packages/phantom-client-sdk/src/userMessages.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 41 | `e` | `error` | `return this.entries.splice(0).map((e) => e.text);` |
| 45 | `e` | `error` | `const i = this.entries.findIndex((e) => e.id === id);` |

## packages/phantom-client-sdk/src/model/cache.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 38 | `m` | `modelMessage` | `const unmark = (m: ModelMessage): ModelMessage => {` |
| 46 | `m` | `modelMessage` | `const mark = (m: ModelMessage): ModelMessage => ({` |

## packages/phantom-backend-sdk/src/tools/registry.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 26 | `t` | `tool` | `export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));` |
| 38 | `t` | `tool` | `const dupes = TOOLS.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);` |

## packages/phantom-backend-sdk/src/tools/notify.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 13 | `me` | `?` | `+ '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean ` |
| 22 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/tools/secrets.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 21 | `s` | `session` | `return { secrets: raw.map((s) => ({ name: s.name, description: s.description, scope: s.sco` |
| 37 | `s` | `session` | `const names = (await ctx.app.settings.listSecrets(chain(ctx))).map((s) => s.name);` |

## packages/phantom-backend-sdk/src/telegram/TelegramAttachments.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 86 | `m` | `message` | `const m = String(mime \|\| '').toLowerCase();` |
| 177 | `s` | `session` | `return [...notes, ...inlined, userText].filter((s) => s && s.trim()).join('\n\n');` |

## packages/phantom-backend-sdk/src/telegram/telegramChannel.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 19 | `s` | `resolveManyResult` | `const s = await settings.resolveMany(['telegram_enabled', 'telegram_authorized_user']);` |
| 26 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/git/autoPull.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 49 | `e` | `autoPullEvent` | `onEvent?: (e: AutoPullEvent) => void \| Promise<void>;` |
| 57 | `r` | `result` | `const r = await syncBranch(deps, session, project,` |

## packages/phantom-backend-sdk/src/git/remote.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 26 | `m` | `match` | `const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);` |
| 39 | `m` | `match` | `const m = clean.match(/^(?:([A-Za-z0-9][A-Za-z0-9-]*)\/)?([A-Za-z0-9_.-]+?)(?:\.git)?$/);` |

## packages/phantom-backend-sdk/src/git/autoPush.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 34 | `e` | `autoPushEvent` | `onEvent?: (e: AutoPushEvent) => void \| Promise<void>;` |
| 42 | `r` | `result` | `const r = await syncBranch(deps, session, project,` |

## packages/phantom-backend-sdk/src/api/routes/presets.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 22 | `r` | `row` | `return ok(rows.map((r) => ({` |
| 42 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/api/routes/tools.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 34 | `h` | `header` | `const h = req.headers['x-phantom-looper-client'];` |
| 105 | `e` | `error` | `} catch (e) { return send(reply, e); }` |

## packages/phantom-backend-sdk/src/api/routes/web.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 41 | `e` | `error` | `catch (e) { return handle(reply, e); }` |
| 65 | `e` | `error` | `} catch (e) { return handle(reply, e); }` |

## packages/phantom-backend-sdk/src/lib/paths.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 23 | `p` | `paths` | `export function sessionDir(p: Paths, sessionId: string): string {` |
| 26 | `p` | `paths` | `export function repoDir(p: Paths, sessionId: string): string {` |

## core/agents/assistant/gitSteps.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 99 | `f` | `file` | `const f = cfg.fetch ?? fetch;` |
| 100 | `r` | `result` | `const r = await f(`${cfg.baseUrl}/git/${route}`, {` |

## phantom-cli/sessionFeed.ts — 2

| line | old | new | the line |
|---|---|---|---|
| 107 | `t` | `target` | `const t = part.type;` |
| 131 | `op` | `?` | `const op = rec.op === 'push' ? 'auto-push' : 'auto-pull';` |

## phantom-cli/components/Tasks.tsx — 2

| line | old | new | the line |
|---|---|---|---|
| 95 | `ch` | `channel` | `onKey={(ch, v) => { if ((ch === 'k' \|\| ch === 'c') && v?.kind === 'live') onKill(v.sid, v.` |
| 95 | `v` | `value` | `onKey={(ch, v) => { if ((ch === 'k' \|\| ch === 'c') && v?.kind === 'live') onKill(v.sid, v.` |

## phantom-cli/components/Text.tsx — 2

| line | old | new | the line |
|---|---|---|---|
| 28 | `ch` | `channel` | `for (const ch of s) {` |
| 29 | `n` | `count` | `if (ch === '\t') { const n = TAB - (col % TAB); out += ' '.repeat(n); col += n; }` |

## packages/phantom-client-sdk/src/messages.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 20 | `p` | `project` | `for (const p of parts) {` |

## packages/phantom-client-sdk/src/ndjson.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 12 | `nl` | `?` | `let nl: number;` |

## packages/phantom-client-sdk/src/cards.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 46 | `it` | `?` | `return items.map((it) => {` |

## packages/phantom-client-sdk/src/update.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 32 | `p` | `project` | `const downloading = Object.values(images).some((p) => p.download < 100);` |

## packages/phantom-client-sdk/src/model/modelResolver.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 26 | `c` | `llmConfig` | `resolve(c: LlmConfig): ResolvedModel {` |

## packages/phantom-backend-sdk/src/tools/database.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 40 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/tools/crons.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 44 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/telegram/handledUpdates.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 19 | `r` | `insertResult` | `const r = await this.db.insert(telegramHandledUpdates).values({ updateId }).onConflictDoNo` |

## packages/phantom-backend-sdk/src/telegram/botState.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 42 | `r` | `row` | `const r = rows[0];` |

## packages/phantom-backend-sdk/src/telegram/bubble.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 56 | `m` | `sendMessageResult` | `const m = await client.sendMessage(chatId, DOTS[0]);` |

## packages/phantom-backend-sdk/src/telegram/TelegramApprovals.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 93 | `m` | `message` | `}).then((m) => { entry.messageId = m?.message_id ?? null; }, () => done(false));` |

## packages/phantom-backend-sdk/src/telegram/connect.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 43 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/git/WorkspaceWatcher.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 57 | `e` | `error` | `child.on('error', (e) => log.error({ pid: child.pid, err: errStr(e) }, 'watcher child erro` |

## packages/phantom-backend-sdk/src/git/watcherChild.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 29 | `m` | `message` | `process.on('message', async (m: Message) => {` |

## packages/phantom-backend-sdk/src/api/HttpApi.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 80 | `fe` | `?` | `const fe = e as { validation?: unknown; message?: string };` |

## packages/phantom-backend-sdk/src/api/routes/database.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 57 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/agents/SettingsEvents.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 25 | `e` | `settingsChanged` | `subscribe(fn: (e: SettingsChanged) => void): () => void {` |

## packages/phantom-backend-sdk/src/storage/Settings.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 170 | `d` | `data` | `const d = this.requireDefinition(key);` |

## packages/phantom-backend-sdk/src/storage/TokenLog.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 23 | `r` | `tokenRecord` | `async record(r: TokenRecord): Promise<void> {` |

## packages/phantom-backend-sdk/src/storage/Projects.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 76 | `e` | `error` | `} catch (e) {` |

## packages/phantom-backend-sdk/src/storage/BackgroundTasks.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 67 | `r` | `row` | `return new Set(rows.map((r) => r.sessionId));` |

## packages/phantom-backend-sdk/src/skills/validate.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 78 | `m` | `message` | `for (const m of body.matchAll(/\]\(((?:references\|templates\|scripts\|assets)\/[^)]+)\)/g)) ` |

## packages/phantom-backend-sdk/src/runtime/Docker.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 10 | `p` | `project` | `for (const p of ['/var/run/docker.sock', path.join(os.homedir(), '.docker/run/docker.sock'` |

## packages/phantom-backend-sdk/src/lib/env.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 26 | `v` | `value` | `const v = source[k];` |

## phantom-backend/sessionTitle.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 17 | `e` | `error` | `} catch (e) {` |

## phantom-backend/telegram/alerts.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 23 | `e` | `boardEvent` | `export function autoBuildAlert(e: BoardEvent, prefix: string): Alert \| null {` |

## phantom-cli/settingGroups.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 26 | `f` | `file` | `const f = filed(item);` |

## phantom-cli/settings.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 36 | `q` | `query` | `const q = (s: Scope = {}) => (s.project ? `?project=${encodeURIComponent(s.project)}` : ''` |

## phantom-cli/follow.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 64 | `r` | `wake` | `await new Promise((r) => setTimeout(r, backoff));` |

## phantom-cli/paste.ts — 1

| line | old | new | the line |
|---|---|---|---|
| 85 | `m` | `match` | `const m = text.match(CHIP_AT_END);` |

## phantom-cli/components/Shimmer.tsx — 1

| line | old | new | the line |
|---|---|---|---|
| 72 | `t` | `target` | `const t = setTimeout(() => setLegs([roll(), roll()]), lo + Math.random() * (hi - lo));` |

## phantom-cli/components/Confirm.tsx — 1

| line | old | new | the line |
|---|---|---|---|
| 44 | `l` | `line` | `{lines.map((l, i) => (` |
