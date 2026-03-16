# CriticMarkup Smart Merge — Test Fixtures

These are the core test cases for the merge algorithm. Each shows the raw document before and after an MCP edit, with CriticMarkup metadata stripped for readability. The actual tests use `strip_metadata()` to compare.

"Accepted view" is what the AI sees via `read`. "Base view" is what you'd get if all suggestions were rejected.

---

### Test 1: Plain text edit changing multiple words

No existing CriticMarkup. The AI changes two words in different places within its old_string. Each changed word gets its own suggestion — unchanged text between them is preserved as-is.

**Before:**
```
Photosynthesis is the process by which green plants convert sunlight into chemical energy for growth.
```

**Edit:** `old_string: "the process by which green plants convert sunlight into chemical energy"`, `new_string: "the process by which all plants convert sunlight into stored energy"`

**After:**
```
Photosynthesis is the process by which {--green--}{++all++} plants convert sunlight into {--chemical--}{++stored++} energy for growth.
```

Two separate suggestions, not one giant `{--the process...energy--}{++the process...energy++}`.

---

### Test 2: Edit not touching existing suggestions, multiple changes

Document has two existing suggestions far apart. The AI changes two words in the middle, neither overlapping any suggestion. All existing suggestions preserved.

**Before:**
```
The {--quick--}{++fast++} brown fox jumps over the lazy dog near the {--old--}{++ancient++} stone wall.
```

**Edit:** `old_string: "brown fox jumps over the lazy dog near the ancient stone"`, `new_string: "brown fox leaps over the happy dog near the ancient stone"`

**After:**
```
The {--quick--}{++fast++} brown fox {--jumps--}{++leaps++} over the {--lazy--}{++happy++} dog near the {--old--}{++ancient++} stone wall.
```

Both original suggestions (quick→fast, old→ancient) untouched. Two new suggestions (jumps→leaps, lazy→happy) added as separate wrappings.

---

### Test 3: Supersede existing suggestion

AI's edit overlaps an existing suggestion. The suggestion is superseded — its base text carries forward. The AI also changes a word elsewhere in the same edit, producing a second independent suggestion.

**Before:**
```
The {--quick--}{++fast++} brown fox jumps over the lazy dog.
```

**Edit:** `old_string: "The fast brown fox jumps over the lazy dog."`, `new_string: "The speedy brown fox jumps over the happy dog."`

**After:**
```
The {--quick--}{++speedy++} brown fox jumps over the {--lazy--}{++happy++} dog.
```

"fast" was the accepted view of the first suggestion. The AI changed it to "speedy", but the base text "quick" carries forward. The "lazy"→"happy" change is a separate, new suggestion on plain text.

Accepted view: `The speedy brown fox jumps over the happy dog.`
Base view: `The quick brown fox jumps over the lazy dog.`

---

### Test 4: Extend suggestion into adjacent plain text

AI's change region covers an existing suggestion and adjacent plain text words. Adjacent changed words merge (single-space absorption), but non-adjacent changes separated by equal words produce separate suggestions.

**Before:**
```
The cell membrane is a {--semipermeable--}{++selectively permeable++} barrier that surrounds the cell.
```

**Edit:** `old_string: "is a selectively permeable barrier that surrounds"`, `new_string: "is a thin flexible boundary that encloses"`

Word diff: "is a" (equal), "selectively permeable barrier" → "thin flexible boundary" (one change region — adjacent changed words merge across spaces), "that" (equal), "surrounds" → "encloses" (second change region).

**After:**
```
The cell membrane is a {--semipermeable barrier--}{++thin flexible boundary++} that {--surrounds--}{++encloses++} the cell.
```

The existing suggestion (semipermeable→selectively permeable) is superseded — "semipermeable" (base text) carries forward into the first suggestion's deletion side. "barrier" (plain text) is absorbed into the same change region. "that" is an equal word so it passes through unchanged. "surrounds"→"encloses" is a separate suggestion.

Accepted view: `The cell membrane is a thin flexible boundary that encloses the cell.`
Base view: `The cell membrane is a semipermeable barrier that surrounds the cell.`

---

### Test 5: Span multiple suggestions with separate change regions

AI's edit covers two existing suggestions, but the word-level diff produces multiple change regions separated by equal words. Each change region independently supersedes any overlapping suggestion. Equal words pass through preserving existing raw content.

**Before:**
```
The {--mitochondria--}{++powerhouse++} is the main {--organelle--}{++structure++} responsible for energy production in cells.
```

**Edit:** `old_string: "The powerhouse is the main structure responsible for energy production"`, `new_string: "The ribosome is the key organelle responsible for protein synthesis"`

Word diff: "The" (equal), "powerhouse" → "ribosome" (change — supersedes first suggestion), "is the" (equal), "main" → "key" (change), "structure" → "organelle" (change — supersedes second suggestion, merges with "main"→"key" via single-space absorption), "responsible for" (equal), "energy production" → "protein synthesis" (change — adjacent changed words merge).

**After:**
```
The {--mitochondria--}{++ribosome++} is the {--main organelle--}{++key organelle++} responsible for {--energy production--}{++protein synthesis++} in cells.
```

First suggestion superseded: base "mitochondria" carries forward. Second suggestion superseded and merged with adjacent "main"→"key" change. The equal words "is the" and "responsible for" pass through unchanged.

Accepted view: `The ribosome is the key organelle responsible for protein synthesis in cells.`
Base view: `The mitochondria is the main organelle responsible for energy production in cells.`

---

### Test 6: Whole-doc replace preserves suggestions in unchanged regions

AI replaces the full document but only changes a couple of words. Existing suggestions in unchanged diff regions are preserved.

**Before:**
```
{--Plants--}{++Organisms++} perform photosynthesis in their chloroplasts during the {--light--}{++day++} cycle.
```

**Edit:** `old_string: "Organisms perform photosynthesis in their chloroplasts during the day cycle."`, `new_string: "Organisms perform respiration in their mitochondria during the day cycle."`

**After:**
```
{--Plants--}{++Organisms++} perform {--photosynthesis--}{++respiration++} in their {--chloroplasts--}{++mitochondria++} during the {--light--}{++day++} cycle.
```

The two original suggestions (Plants→Organisms, light→day) are in equal regions of the word diff and stay untouched. Two new suggestions added for the changed words.

---

### Test 7: No-op edit leaves document unchanged

AI submits an edit where old and new are identical. No mutations, existing suggestions preserved exactly.

**Before:**
```
The {--quick--}{++fast++} brown fox jumps over the {--lazy--}{++sleepy++} dog.
```

**Edit:** `old_string: "The fast brown fox jumps over the sleepy dog."`, `new_string: "The fast brown fox jumps over the sleepy dog."`

**After:**
```
The {--quick--}{++fast++} brown fox jumps over the {--lazy--}{++sleepy++} dog.
```

Identical to before. No mutation at all.

---

### Test 8: Triple supersede chain

AI edits the same region three times. Each edit supersedes the previous. The original base text survives through all three.

**Before:**
```
The process of cellular respiration converts glucose into ATP for energy.
```

**Edit 1:** `old_string: "converts glucose into ATP for energy"`, `new_string: "transforms glucose into ATP for fuel"`

**After edit 1:**
```
The process of cellular respiration {--converts--}{++transforms++} glucose into ATP for {--energy--}{++fuel++}.
```

**Edit 2:** `old_string: "transforms glucose into ATP for fuel"`, `new_string: "transforms sugar into ATP for fuel"`

**After edit 2:**
```
The process of cellular respiration {--converts--}{++transforms++} {--glucose--}{++sugar++} into ATP for {--energy--}{++fuel++}.
```

**Edit 3:** `old_string: "transforms sugar into ATP for fuel"`, `new_string: "breaks down sugar to produce ATP for fuel"`

Word diff: "transforms" → "breaks down" (change — adjacent changed words merge via space absorption; supersedes existing suggestion, base "converts" carries forward), "sugar" (equal — passes through preserving the `{--glucose--}{++sugar++}` suggestion from edit 2), "into" → "to produce" (change — adjacent changed words merge), "ATP for" (equal), "fuel" (equal — passes through preserving `{--energy--}{++fuel++}` suggestion from edit 1).

**After edit 3:**
```
The process of cellular respiration {--converts--}{++breaks down++} {--glucose--}{++sugar++} {--into--}{++to produce++} ATP for {--energy--}{++fuel++}.
```

Base view after all edits: `The process of cellular respiration converts glucose into ATP for energy.`
The original text always survives as the base, no matter how many times the AI revises. The `{--glucose--}{++sugar++}` suggestion from edit 2 is preserved because "sugar" is in an equal region of edit 3's diff.

---

### Test 9: Edit adjacent to suggestion without overlapping

AI changes a word right next to an existing suggestion. The suggestion is completely untouched — the edit produces a new, separate suggestion.

**Before:**
```
The quick brown {--fox--}{++cat++} jumps gracefully over the tall wooden fence.
```

**Edit:** `old_string: "cat jumps gracefully over the tall wooden fence"`, `new_string: "cat leaps gracefully over the tall wooden fence"`

**After:**
```
The quick brown {--fox--}{++cat++} {--jumps--}{++leaps++} gracefully over the tall wooden fence.
```

The original suggestion (fox→cat) is untouched. The new suggestion (jumps→leaps) is separate. The word-level diff correctly identifies only "jumps" as changed — the rest of the old_string is in equal regions.

---

### Test 10: Metadata preservation and creation

Full metadata shown (not stripped). Tests three things: (1) existing suggestion metadata is preserved when not overlapped, (2) new suggestions get correct AI metadata, (3) superseded suggestions lose their old metadata and the merged result gets new AI metadata.

The AI edit timestamp is `1700000120000` (2 minutes after the existing suggestions).

**Before:**
```
The {--{"author":"Human","timestamp":1700000000000}@@quick--}{++{"author":"Human","timestamp":1700000000000}@@fast++} brown fox {--{"author":"AI","timestamp":1700000060000}@@jumps--}{++{"author":"AI","timestamp":1700000060000}@@leaps++} over the lazy dog.
```

**Edit:** `old_string: "fast brown fox leaps over the lazy dog"`, `new_string: "fast brown fox leaps over the happy dog"`

Only "lazy" → "happy" changes. The two existing suggestions are in equal regions of the diff.

**After:**
```
The {--{"author":"Human","timestamp":1700000000000}@@quick--}{++{"author":"Human","timestamp":1700000000000}@@fast++} brown fox {--{"author":"AI","timestamp":1700000060000}@@jumps--}{++{"author":"AI","timestamp":1700000060000}@@leaps++} over the {--{"author":"AI","timestamp":1700000120000}@@lazy--}{++{"author":"AI","timestamp":1700000120000}@@happy++} dog.
```

- Human suggestion (quick→fast) at t=0: **preserved exactly**, metadata untouched
- AI suggestion (jumps→leaps) at t=60s: **preserved exactly**, metadata untouched
- New suggestion (lazy→happy) at t=120s: **created with new AI metadata**

Now a second edit supersedes the Human suggestion. Timestamp `1700000180000` (3 minutes after original).

**Edit 2:** `old_string: "The fast brown fox leaps over the happy dog"`, `new_string: "The speedy brown fox leaps over the happy dog"`

Only "fast" → "speedy" changes, overlapping the Human suggestion.

**After edit 2:**
```
The {--{"author":"AI","timestamp":1700000180000}@@quick--}{++{"author":"AI","timestamp":1700000180000}@@speedy++} brown fox {--{"author":"AI","timestamp":1700000060000}@@jumps--}{++{"author":"AI","timestamp":1700000060000}@@leaps++} over the {--{"author":"AI","timestamp":1700000120000}@@lazy--}{++{"author":"AI","timestamp":1700000120000}@@happy++} dog.
```

- Superseded suggestion: Human metadata **replaced** with new AI metadata at t=180s. Base text "quick" carries forward.
- Other two suggestions: **untouched**, their metadata preserved exactly.
