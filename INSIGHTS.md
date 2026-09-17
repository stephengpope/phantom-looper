# Insights

Reusable lessons from the work, written as rules. Each one was paid for by
a real mistake or a real find; the source is named so it can be checked.
Meant to feed the shared value system's prompts later — keep entries
general, short, and true.

## Understanding

- **Reading beats counting.** A grep count said "queries are contained";
  reading each hit found a route running DDL. A "clean" table (`folders`)
  needed no untangling, but reading its callers found nine copies of a
  transcript header and a delete that always 500ed. Step 1 of any change is
  reading every call site, not tallying them. *(tables 1, 2)*
- **Know what kind of thing you have before proposing.** A table that cannot
  be protected can only be deleted, and deleting it changed the whole job.
  Classify first, plan second. *(table 1)*
- **A field's name comes from its one write and its readers, not its
  comments.** `claim_sha` was "base's tip" in every comment and the source
  branch's tip for a duplicate. The truth was in `rev-parse HEAD` after
  checkout and the one `rev-list` that read it. *(table 2)*
- **A record nobody reads is not a record; it is duplication.** The transcript
  header carried nine fields; one was read. The rest mirrored the session
  row and drifted from it. Ask "who reads this?" before "is it correct?"
  *(header pass)*
- **Structure thrown away at write time and rebuilt at read time is a bug
  waiting.** The prompt was stored glued and cut apart on every turn by
  prefix-matching. Store the parts you use. *(header pass)*
- **Design from how it should work, not from how the code works today.**
  "A session is on a card only if the looper put it there" was a true
  description of the code and a wrong design; every answer that started
  from the code re-described the wrong thing. State the model first (what
  the things are, how they connect), then measure the code against it.
  *(table 3)*
- **A fact lives on the thing it describes.** The card a session works on
  sat on the looper's pairing row, so it existed only while a loop did.
  Ask "whose fact is this?" — the answer names the table. *(table 3)*
- **A one-to-one link is a column, not a table.** With the card moved off
  it, `loops` held one link. A table + an object + a migration to carry one
  column is complexity with no payoff. *(table 3)*
- **Storage links use the primary key; people use the handle.** Two tables
  linked to cards by number. The number is what PHA-7 means to a person and
  an agent; the key is what a foreign key is for. *(table 3)*

## Simplicity

- **The same object built by hand in N places will drift; one of them is
  already wrong.** Nine header builders: two dead, one writing a folder id
  as a branch, one freezing an empty prompt. One constructor or none.
  *(header pass)*
- **Data that belongs to X lives on X.** The frozen prompt belongs to the
  session, not to line 1 of a file the session owns. It sat there because
  the file once was the only storage. History is not a reason. *(header pass)*
- **Rename in the pass, not after.** Parking a rename as a "raised item" is
  a step skipped; the reviewer catches it. Names go all the way to the edge
  — API field, cli, tools, prompt blanks. *(tables 1, 2)*

## Proof

- **Seed the old shape, not the new one.** Colliding ids, a deleted card, a
  moved card, a destroyed session, a supervisor sharing a folder, an orphan
  folder: the awkward rows are what find trigger and FK bugs. Reading the
  code never would have. *(tables 1, 2)*
- **Prove the destructive path with rows in every state.** Workspace delete
  was covered for active sessions; a single destroyed session row was the
  500. *(table 2)*
- **Object tests pass; the live layer finds the live layer.** A helper
  sending `content-type: json` on a bodiless DELETE only shows up over HTTP.
  Always walk the routes too. *(table 1)*
- **When challenged, run the code.** "The split works today" was proven by a
  script over three cases in under a minute — and settled it. Belief on
  either side costs more than the script. *(header pass)*
- **Prove from a `.ts` script, not a shell harness.** `echo` and `$(...)`
  mangle `\n` inside JSON and turn passes into noise. *(table 2)*
- **A failed harness step can poison the next assertion.** A DELETE that
  500ed left a lock held; the next round was skipped and "reused the pair"
  passed trivially. When a live check passes suspiciously fast, read the
  server log for the round it claims ran. *(table 3)*
- **Two joins that each multiply rows multiply each other.** `loops` on
  either seat × `token_usage`, then SUM: a session in two loop rows
  doubled its tokens. Aggregate over one join, or in a subquery. *(table 3)*
- **Scaffolding lives outside the repo,** copied into a gitignored
  `scratch-tmp/` only for the run, moved out after. *(table 1)*

## Communication

- **Answer the question asked, only that.** Asked "how does it work now?",
  the right reply was two sentences on the cut; each extra paragraph on
  caching, options, or history read as not knowing. *(header pass)*
- **Do not explain the builder's own design back to them.** State what the
  code does with file:line, then the change. *(header pass)*
- **Overstating loses trust faster than being wrong.** "Freezing buys
  nothing" was false; "freezing protects one turn per session inside the
  cache window" was the fact. Say the number. *(header pass)*
- **Words mean what they say.** "Create a cards table" when one exists is
  wrong; "move the cards into one table" is right. *(table 1)*
- **When the builder pastes a specific list, that list is the scope.** Fixing
  the six unused imports was the ask; folders was not. *(cleanup)*
- **Nothing raised, nothing deferred.** "Next steps" with work still open
  reads as unfinished. Finish, then report. *(project rule)*
- **A rule found in this pass is fixed in this pass, wherever it applies.**
  "Storage links use the key" was set on `loops` and parked for
  `card_revisions` as "table 11's". Same rule, same fix, ten minutes;
  parking it was a step skipped. *(table 3)*
- **A type that lies is a bug, not a note.** `sqlRaw<number>` over a bigint
  SUM returned strings; it "worked" by coercion. Raising it as a later
  table's concern was wrong — the number the type promises is the fix.
  *(table 3)*
- **When the builder says "I'm not following", show the rows.** Six
  paragraphs of description failed; two before/after tables landed in one
  message. A data change is explained with data. *(table 3)*
- **Do not carry a scenario the builder did not ask for.** "Delete" was my
  concern, raised as a finding; every later explanation dragged it along
  and muddied the model. A raised concern is answered once, then dropped
  unless picked up. *(table 3)*
