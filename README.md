# ACACIA Penpal Bot

A standalone Telegram participant bot and a separate organiser admin bot. Participants can register immediately, before survey data is available. CSV imports and pairing previews never start the game automatically.

## Setup

Requires Node.js 22 or newer. Run commands from this folder.

1. Create two new bots using Telegram's BotFather: one participant bot and one admin bot.
2. Copy `.env.example` to `.env`. Enter their distinct tokens and a comma-separated list of organiser **numeric Telegram user IDs**. A Telegram username is not an admin ID. Your numeric ID can be obtained from Telegram's account data export (`personal_information.user_id`).
3. Install and start:

   ```powershell
   npm.cmd ci
   npm.cmd start
   ```

4. Open the participant bot and use `/start`. This works even with an empty roster. Open the admin bot and use `/menu` or `/help`.

Keep `.env`, `data/`, backups, exports, and organiser documentation private. Use a persistent disk and run one instance per data directory. Do not enable Telegraf debug logging: it can include submitted hint passwords.

## Running an event

1. Share the participant bot link immediately. `/start` records Telegram ID and available handle; participants receive a waiting message. Everyone registered can receive broadcasts even without a survey profile.
2. In the admin bot, use `/import` and send a survey CSV. Review validation results and `/confirm` the import. Imports replace the **draft survey roster**, preserve Telegram registrations, and clear draft pairings.
3. Check `/accounts` for registrations without linked profiles and `/list` for survey profiles. Handles match case-insensitively, ignoring `@`. Numeric account bindings survive handle changes. Resolve missing/changed handles with `/link <telegram_id> <code>`; use `/unlink <telegram_id>` first if a profile is bound to the wrong account. Participants without a username must use admin-assisted linking.
4. Use `/compatibility` and upload your completed MBTI matrix. The supplied template intentionally has empty scores: organisers must enter their chosen scores rather than accidentally use invented compatibility rules.
5. Use `/generate`, review `/pairs`, and optionally regenerate. Pairing first maximises the number paired, then total MBTI score, with random tie-breaking. Different houses and both gender preferences are mandatory. Everyone with a survey profile is eligible, even if they have not opened the bot. Accounts lacking profiles are excluded. Unpaired profiles remain waitlisted.
6. Correct profiles with `/edit <code> <field> <value>` or adjust pairs with `/pair <code> <code>`. Valid editable fields are the template column names. Edits invalidate draft pairing approval; changing house also reassigns that person's code. A manual pair removes both participants' prior pairs, leaving their former partners waitlisted.
7. Set five different passwords using `/sethint house <password>` and repeat for `major`, `year`, `gender`, and `name`. Passwords must contain 4–128 characters with no spaces. Only salted scrypt hashes are stored. Submitted password messages are deleted when Telegram permits it. Distribute the passwords separately at your chosen times.
8. `/approve` the reviewed pairings, then `/launch`. Review the full assignment and note preview and confirm. Launch freezes assignments and sends each registered paired participant their nickname/code and their penpal's nickname/code/note. Review notes for accidental identity disclosure. Real names are withheld until the name hint.
9. Participants registering or linking afterward retrieve their existing assignment. People with no profile or no pair receive a clear waiting status. No new pairings are created after launch.

## Commands

Participants: `/start`, `/status`, `/hint <password>`, `/help`. Hint passwords unlock their corresponding fields independently, in any order. Reusing a password repeats the same hint. Five incorrect attempts temporarily block guesses for one minute. No chat or media is relayed between participants.

Admins can use `/help` for the full command list. Main controls:

| Command | Behaviour |
|---|---|
| `/broadcast <text>` | Preview and confirm text to all registered accounts, including pending and waitlisted accounts. Recipients are captured on confirmation. |
| `/jobs` | Show delivery counts per launch, assignment, or broadcast job. |
| `/retry <job_id>` | Retry failed deliveries, excluding successful and uncertain sends. |
| `/retryuncertain <job_id>` | Explicitly retry uncertain sends too; duplicates are possible. |
| `/pause`, `/resume` | Suspend or reopen hint access. Assignments remain readable. |
| `/end` | Close hints permanently for this round; preserve assignment lookup. |
| `/export` | Download a private roster CSV with codes, linked account IDs, and penpal codes. |
| `/backup` | Download a complete private JSON snapshot, including pending actions and password hashes. |
| `/audit` | Recent management actions, without password text. |
| `/reset` | Download a backup, then confirm clearing the game while preserving registered Telegram accounts. Wait for queued deliveries to finish first. |
| `/cancel` | Cancel the latest confirmation or upload request. |

Confirmations expire in 15 minutes and belong to the requesting admin. Game configuration changes invalidate pending confirmations. Pairings, survey data, and the MBTI table can change only before launch; start a new round with an explicit reset.

## CSV formats

`templates/participants.csv` demonstrates the supported format. The ten original survey question headings are also accepted. Other survey-export metadata columns are ignored. Export Excel responses as UTF-8 CSV before uploading; Excel uploads are not supported.

Required columns: `name,house,year,mbti,major,gender,telegram,nickname,preference,note`. All ten answers must be present; use `None` for an introductory note if appropriate. Houses: Aeon, Genesis, Nous, Telos, Zenith. Years: Y1–Y4. Gender: Male or Female. Preference: Any, Male, or Female. MBTI must be one of the 16 four-letter types. Handles must be unique. Preserve the four-character codes as text if opening exports in Excel.

`templates/mbti-compatibility.csv` is a 16×16 matrix. Keep the `MBTI` column and all 16 type columns. Enter integer scores from 0 to 100, including diagonal scores. Scores must be symmetric. Invalid imports are rejected without partial updates. CSV uploads are limited to 2 MB.

## Persistence and recovery

State is stored in `data/state.json`, or `DATA_DIR` if configured. Writes are serialised and committed by atomic file replacement. Telegram update offsets are persisted. A process lock prevents concurrent instances from overwriting the same data directory.

Use `/backup` for a snapshot while running. To restore: stop the process, securely copy a valid backup to `DATA_DIR/state.json`, then restart. For a filesystem backup, stop the process and copy the whole data directory. Reset preserves account registrations and polling offsets, but clears profiles, links, hints, and delivery history. Restoring an old backup can repeat activity performed after that backup.

After an unclean crash, verify no instance is still running before removing the stale `data/process.lock`. Then restart. Never delete the state file to resolve a lock error. A storage parse error stops startup instead of silently discarding the game.

Delivery jobs persist individual recipient results. Rate-limit responses are retried after Telegram's requested delay. A crash during sending or an ambiguous network failure marks the recipient `uncertain`: Telegram may already have accepted the message. These are never resent automatically. `/retryuncertain` is an explicit organiser decision to accept possible duplicates. Account unlinking cancels pending assignment messages; messages already sent or in flight cannot be recalled.

Telegram must be reachable for live operation. The test suite mocks Telegram and does not send live messages:

```powershell
npm.cmd test
```

## Matching implementation

The weighted general-graph matching engine is vendored from [Matt Krick's EdmondsBlossom](https://github.com/mattkrick/EdmondsBlossom), under its included MIT licence (`src/vendor/LICENSE`). Local fixes correct blossom boundary comparisons and variable scope. Tests compare matching results against exhaustive optimisation on small graphs. Telegraf follows the existing workspace's 3.x API, with a separate polling loop that avoids printing credentials or update bodies.
