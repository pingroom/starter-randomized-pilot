# Randomized pilot with PingRoom

Assign 2–8 fixed practice units evenly between two procedures, collect binary outcomes from one named operator through PingRoom, and export an exact randomization analysis. The example compares two ways to look up codes on harmless practice cards. The application records assignments and answers; the operator performs the procedures separately.

Save the random allocation before performing procedures or collecting outcomes. The input, assignment, operator and connection remain fixed throughout the session.

## Try it offline

Choose **Use this template**, then clone your repository. Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run demo
```

The demo and tests use the real pinned `@pingroom/sdk@0.7.1` with a local mock transport. They need no credentials or network after installation; live phone delivery is not tested. The lockfile pins dependencies; `.npmrc` requires a 14-day release age for installs that support it. CI runs tests and demo on Node.js 22 and 24.

## Set up your pilot

```sh
cp examples/pilot.json pilot.json
cp config.example.json config.json
npm run preview
npm run connect
npm run inspect
```

Before allocating, edit `pilot.json` to define:

- A stable `pilotId`, short `title`, and shared binary `successCriterion`.
- Exactly arms `A` and `B`, each with a label and a different, fixed, harmless procedure.
- An even number of units: 2, 4, 6 or 8. Each has a unique stable ID and a description identifying the fixed task or object.

IDs use lowercase letters, digits, `_` and `-`, starting with a letter. Unit IDs allow 24 characters; the pilot ID allows 40. Text limits are 32 UTF-16 units for the title, 16 for arm labels, and 70 for procedures, descriptions and the criterion. Text must be trimmed, well-formed Unicode on one line. Controls and formatting characters, including ZWJ/ZWNJ, are unsupported. Unit and arm array order is canonicalized; changing content after allocation is refused.

`connect` displays a PingRoom approval link and stores the resulting connection privately. Choose a standard private room containing the operator. `inspect` lists member UUIDs; verify the intended person in PingRoom and copy their exact UUID into `config.json`. The label is for your records. The on-phone Question includes the unit, assigned procedure and criterion, and accepts only that UUID's response.

For an **existing robot only**, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`, with room access and Question read/write scopes. Partial shell overrides fail instead of borrowing from saved credentials. SDK pairing is built in; no global CLI is required.

## Allocate, perform, collect

```sh
npm run allocate
npm run status
```

**Allocate before performing any trial procedure or observing outcomes.** Follow each unit's arm in the saved `allocation.assignments`. The application uses `crypto.randomInt` to select uniformly from every balanced allocation, at most 70 possibilities. `allocate` saves the assignment without creating a Question. Repeating it returns the same assignment.

Perform the declared harmless procedures outside the app. Then collect each recorded outcome:

```sh
npm start
# Answer Success, Failure, or Unknown in PingRoom.
npm start
```

Each invocation creates or reads at most one Question. After an answer is recorded, the next invocation asks about the next unit. At most eight Questions are created, each expiring after 900 seconds; prepare measurements before collection. Unknown, expiry, cancellation or an invalid response blocks the entire analysis and export. The starter never drops a unit or reasks a terminal outcome.

```sh
npm run report
npm run export
```

Both commands work offline. A complete export writes private `.pilot/pilot-analysis.json`, including the fixed manifest, source hash, allocation, attributed answers, counts, rates and exact tail count. No procedure, infrastructure change, upload or deployment is executed.

## Interpret the result

For equal arm size `m`, the reported signed difference is `(successesA - successesB) / m`. Under the sharp null that each unit's outcome would be unchanged by assignment to A or B, the analysis holds all recorded binary outcomes fixed and enumerates every balanced reassignment. It counts assignments with `abs(successesA - successesB)` **at least** the observed value, including ties and the actual assignment. The p-value includes its integer numerator and denominator. This is exhaustive enumeration, with no Monte Carlo or plus-one correction.

The [Berkeley randomization-test lab](https://stat158.berkeley.edu/spring-2026/labs/02-randomization-tests/lab.pdf) introduces the sharp-null framework. This starter uses the absolute-tail convention above with exact enumeration for its bounded sample. It assumes the saved assignment was followed and does not model interference between units. Results do not alone establish causality, generalizability or adequate power; the app selects no winner. Allocation integrity assumes untouched local files. Hashes check consistency, not whether randomization occurred.

## Resume safely

Keep `.pilot/allocation.json`, `.pilot/state.json`, the original input/configuration and `.pingroom/` together. A `prepared` allocation journal means initialization was interrupted; `status` may report `allocation_prepared`. Resume with `npm run allocate` using the original connection and saved assignment. Once active, a missing state or journal stops processing: restore matching originals instead of deleting files or redrawing. `connect` refuses to pair again while allocation or state exists.

A lost creation response becomes `create_unknown`:

```sh
npm run status
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

Recovery verifies the exact request, allocation, target, room and asking registration. An empty search is not proof that creation failed; it never authorizes another POST. Interrupted pairing resumes its saved request. Uncertain pairing creation requires inspecting Connected Agents before any intentional new setup.

Exit codes: `0` complete or successful local/allocate command; `1` validation, storage or transport error; `2` incomplete/failed outcome; `3` pending, ready or interrupted; `4` uncertain creation. Private files use bounded reads, atomic writes, locks and restrictive permissions, and are Git-ignored. After a crash, remove a stale lock only after confirming no process still owns it.

Adapt the manifest and your procedure outside the application before allocation. Keep validation, assignment persistence and the exact analysis in application code. The tests compare 19,304 assignment/outcome cases against an independent hypergeometric oracle and exercise SDK responses, interrupted saves, recovery and actual CLI processes.

MIT licensed.
