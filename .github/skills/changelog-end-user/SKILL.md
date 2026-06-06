---
name: changelog-end-user
description: 'Write or update CHANGELOG.md entries for new versions with end-user language. Use when preparing a release note that explains user-facing value, behavior changes, fixes, and upgrade impact rather than commit-by-commit technical details.'
argument-hint: 'Version, date, compare-from version, and key changes to communicate'
user-invocable: true
---

# End-User Changelog Updates

## Purpose
Create release entries in `CHANGELOG.md` that help users quickly understand what changed, why it matters, and what actions (if any) they should take.

## Use When
- A new version is being released
- Existing release notes are too technical or commit-oriented
- You need consistent, user-friendly messaging across versions

## Inputs to Collect
- Target version and release date
- Previous version used for comparison (for "Changes since ...")
- List of shipped changes (PRs, issues, or summaries)
- Intended audience (admins, editors, all users)
- Any migration steps, deprecations, or behavior changes

If key inputs are missing, ask for them before writing.

## Procedure
1. Read current `CHANGELOG.md` to match heading style, section format, and tone.
2. Collect release changes from trusted sources (release branch notes, merged PR list, product brief, QA notes).
3. Filter to user-facing impact only:
   - Keep: visible features, UX improvements, reliability fixes, security and policy changes, breaking changes.
   - Drop: internal refactors, dependency bumps, renames, low-level implementation details with no user impact.
4. Group changes into clear user outcomes:
   - New capabilities
   - Improvements
   - Fixes
   - Security or compliance updates
   - Breaking changes or required actions
5. Rewrite each point in plain language:
   - Lead with outcome first ("You can now...", "Editing is more reliable...").
   - Keep one meaningful idea per bullet.
   - Mention scope when relevant (mobile, admin-only, multilingual flow).
6. Add release entry with this shape:
   - `## vX.Y.Z - YYYY-MM-DD`
   - 3-10 concise bullets ordered by user value.
7. Quality-check before saving:
   - Every bullet answers "What changed for the user?"
   - No commit hashes, internal file names, or code-level jargon.
   - Consistent tense and punctuation with nearby entries.
   - Dates and versions are correct.
8. If details are uncertain, flag assumptions explicitly and request confirmation.

## Decision Points
- If there are fewer than 3 meaningful user-facing changes:
  - Collapse into a short patch-style note focused on key fixes and polish.
- If there is a breaking or migration-impacting change:
  - Add a dedicated bullet that starts with `Action required:` and states exactly what users must do.
- If a change impacts only a subset of users:
  - Name that audience in the bullet (for example, "For newsletter editors...").
- If a technical item still matters to users (for example, security hardening):
  - Keep it, but express the practical impact and risk reduction.

## Completion Criteria
- Entry exists at the top for the target version.
- Language is understandable to non-engineers.
- Content is impact-first, not implementation-first.
- Breaking changes and required actions are explicit.
- Final note reads like release communication, not a git log.

## Output Format Example
`## v1.2.0 - 2026-06-05`

`Changes since v1.1.0:`
- Added a guided newsletter setup flow so first-time editors can publish faster.
- Improved autosave conflict handling to reduce accidental overwrites during collaborative editing.
- Fixed preview rendering for wide tables to better match sent email output.
- Action required: regenerate API tokens created before 2026-06-01 to keep scheduled sends working.

## Prompt Examples
- `/changelog-end-user Draft v1.2.0 entry from these merged changes: ...`
- `/changelog-end-user Rewrite this draft to be less technical and more user-facing`
- `/changelog-end-user Propose a concise patch release note for v1.2.1 from these bug fixes`
