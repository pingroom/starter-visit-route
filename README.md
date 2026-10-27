# PingRoom visit route

Ask one named operator which stops are required, then compute the shortest closed
route through those stops using a fixed directed travel-cost matrix. PingRoom
collects **Required**, **Skip**, or **Unknown**; application code validates the
answers and chooses the route.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer
on macOS or Linux with private persistent storage:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real SDK with an in-memory HTTP transport. It shows a 12-minute
tour, an unreachable return, and an Unknown answer that blocks routing. It needs
no credentials, makes no network requests, and removes its temporary state.
Installation needs npm access. Live phone delivery is not tested.

## Set up your visits

```sh
cp examples/route.json route.json
cp config.example.json config.json
npm run preview
npm run connect
npm run inspect
```

Before starting, edit `route.json`: set a `routeId`, title, `costUnit`, fixed
`depot`, and 1–8 stops with IDs, labels, and details. `travel.ids` names the depot
and every stop exactly once. `travel.costs[i][j]` is the cost from row ID `i` to
column ID `j`. Diagonals must be zero; other entries must be positive integers
up to 1,000,000, or `null` for an unreachable leg. All costs share the declared
unit. Asymmetric costs are allowed. `preview` validates and prints the canonical
matrix without credentials or API calls.

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and select a
**standard private room** containing the operator. Review the server-defined
agent-feature grant and delegate that room. Normal permissions and quotas apply.
The operator may be your account or another room member.

`inspect` lists member UUIDs and names. Verify the person in the app, then put
their exact UUID and a local label in `config.json`. Names are lookup aids.
Pairing saves private `.pingroom/credentials.json` and resumes its saved link while
pending. If pairing creation is uncertain or expires, inspect Connected Agents and
resolve or revoke the old robot before archiving `.pingroom/pairing.json` for new
setup.

Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank
pairs fail. Defining either shell variable selects the shell pair without
borrowing from `.env`. Paths resolve from this project directory.

## Collect choices and export

```sh
npm start          # Ask the next stop, or read its existing Question once.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read saved evidence offline.
npm run report     # Also save private .route/report.json.
```

Stops are asked in lexicographic ID order. Each invocation creates or reads at
most one Question; only one is active, with a 15-minute lifetime. There is no
scheduler. Required includes a stop once; Skip excludes it. Unknown, missing,
expired, cancelled, invalid, or uncertain answers withhold the route. Remaining
stops may still be classified, but terminal requests are never reissued within
the session. Unknown never becomes Skip.

The report records every choice, Question ID, responder UUID, asking registration,
and answer/observation time. It separates `requiredStopIds`, `skippedStopIds`,
`unknownStopIds`, and `unansweredStops`. Historical reports replay locally without
checking current room access or current travel conditions.

Use the result only when top-level `status` is `complete` and `route.status` is
`feasible`. Then `route.tour`, `legs`, `totalCost`, and `costUnit` describe the plan.
An infeasible result has a diagnostic route object with `tour: null` and
`totalCost: null`; incomplete answers have `route: null`. All Skip produces the
single-node tour `[depot]` with zero cost.

## What the optimizer solves

The optimizer searches at most 8! stop permutations for the minimum-cost closed
tour: start at the depot, visit every Required stop exactly once, and return to the
depot. Equal-cost tours use the lexicographically smallest stop-ID sequence.
A tour requires every directed leg, including the return leg, to be reachable.
The largest accepted tour cost is 9,000,000, within exact integer arithmetic.

Supply a fixed cost for each pairwise leg; precomputed travel costs are allowed.
The optimizer does not traverse skipped or absent stops to invent missing
legs, calculate road paths, or fetch maps. The complete matrix and stop set stay
immutable during collection. This is a Hamiltonian closed tour over the Required
subset; it does not model traffic, service durations, appointments, capacity,
multiple vehicles, or dispatch. Review the plan before using it elsewhere.

## Resume and recover

State binds the canonical input hash, operator, room, and credential fingerprint.
Reordering stops or matrix rows/columns together is immaterial; changing a cost,
ID, label, detail, unit, or connection fails. Before sending, code saves and syncs
the exact payload, TTL, correlation, and idempotency key. A lost or malformed
response or failed save may leave `create_unknown`; later runs do not repeat that
POST or move on to another stop.

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads up to 200 recent Questions and lists matching candidates. An empty
result does not prove creation failed. If needed, locate the original ID in the
robot's history or saved response. Recovery reads that exact ID and validates the
request, room, target, original asking registration, and timestamps. Keep the
original registration for these reads.

Only exact options from the named server-authenticated responder count. Answer
and resolution times must agree within the Question lifetime; expiry can be
recorded after its deadline. Observation time cannot regress. Implausible future
times fail, allowing 60 seconds of clock skew.

Keep state while investigating uncertain work. After resolving active/uncertain
Questions, archive the entire `.route/` directory before starting a new route ID
and manifest. Preserve old evidence. Do not use another checkout to retry the
same session or edit saved answers. State is not tamper-evident against someone
with filesystem access.

`start`/`recover` exit codes: `0` feasible complete route; `2` infeasible/incomplete
or newly observed expired/cancelled/invalid answer; `3` ready/pending/interrupted;
`4` uncertain creation; `1` errors. Unknown can leave `ready` while more stops
remain. Local commands exit `0` when readable; inspect their JSON status.

## Adapt the integration

Call `step` in `src/engine.js` from your workflow runner. `src/model.js` owns
validation, attribution, and optimization; keep deterministic rules there.
Replace the harmless visit descriptions and supply a fixed matrix from your own
source before collection. No deployment, booking, notification to third parties,
or navigation action is implemented. No AI service is required, and text is
never executed as a command or fetched as a URL.

IDs start with a lowercase letter and use lowercase letters, digits, `_`, or `-`:
route IDs allow 40 characters, location IDs 24. Reserved prototype IDs fail.
Text is printable ASCII without outer spaces: title 60, cost unit 20, location
label 40, stop details 100, operator label 60 characters. Input is capped at
64 KiB, config at 16 KiB, state/reports at 1 MiB, and HTTP bodies at 512 KiB.

Storage uses private temporary files, file sync, atomic rename, directory sync,
and a per-directory lock. After a crash, inspect `.route/.lock/owner.json` or
`.pingroom/.lock/owner.json`; confirm the owner stopped before removing only the
stale lock. Restore corrupt data from a valid backup. POSIX files use `0600` and
directories `0700`; keep backups private. Credentials, local input, state, and
reports are ignored by Git. Local storage and server idempotency do not promise
distributed exactly-once execution.

The [official SDK](https://github.com/pingroom/sdk) is pinned to `0.7.0` with a
lockfile and 14-day minimum release age. Requests stay on the official API origin,
reject redirects, and have a five-second deadline through body consumption.
Tests include an independent subset-DP oracle, directed unreachable graphs,
ties, input permutations, recovery, and real CLI exit codes. GitHub Actions runs
these tests and the offline demos on Node 22 and 24. MIT licensed; see
[LICENSE](LICENSE).
