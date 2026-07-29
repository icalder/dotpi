---
name: ste-writing
description: Rewrite prose (docs, READMEs, PR descriptions, error messages, release notes, comments — never code) into ASD-STE100 Simplified Technical English to remove "AI slop". Use when asked to make writing not sound like AI, make docs clear or plain, enforce a controlled writing style, or write technical documentation that reads human. Two modes — strict (procedures/safety) and STE-flavored (general prose).
---

# ste-writing

Write prose in ASD-STE100 Simplified Technical English. This applies to documentation, READMEs, pull-request text, error messages, release notes, and comments. It does not apply to code, identifiers, or command syntax. It is not for marketing copy, essays, or anything that needs a voice — STE strips voice on purpose.

## Rules

WORDS
- Use one name for one thing. Do not call the same item by two different names.
- Use the short common word: start (not begin/commence/initiate), use (not utilize/leverage), help (not facilitate), make sure (not ensure), before (not prior to), after (not subsequent to), about (not regarding/concerning), get (not obtain/acquire), show (not demonstrate), also (not additionally/furthermore/moreover).
- Give each word one meaning. "fall" means to move down, not to decrease.
- No marketing adjectives: seamless, robust, powerful, cutting-edge, effortless, world-class, next-generation, revolutionary.
- American spelling.

VERBS
- Active voice. "the parser reads the file", not "the file is read by the parser".
- Use a verb for an action. "analyze the log", not "perform an analysis of the log".
- No stacked auxiliaries. Not "it is important to note that this may help to improve". Write "this improves X".
- No "-ing" main verb where a simple tense works.

SENTENCES
- One instruction per sentence. Max 20 words (instruction), max 25 (descriptive).
- No contractions. Use articles: a, an, the, this, these.

PUNCTUATION
- No semicolons. Write two sentences. (Note: the em dash is not banned by STE, only the semicolon is — add "no em dash" yourself if you want it gone.)

STRUCTURE
- One topic per paragraph, max six sentences. For steps, use a numbered vertical list, one action per item, imperative form. Put a condition before its command.

Write only the requested text. No preamble, no summary, no closing remarks.

## Modes

- **strict** — procedures, runbooks, safety text, error messages: apply every rule and both length caps.
- **STE-flavored** — general prose (READMEs, PR descriptions, docs): apply the sentence, paragraph, active-voice, and no-phrasal-verb discipline; relax the ~900-word dictionary lockdown so the text keeps enough range to read naturally.

## Self-lint (run before returning text)

Write the text to a file, then run the checker. Do not hand-write grep commands for this.

```
python3 ~/.claude/skills/ste-writing/scripts/ste-lint.py --mode flavored FILE
```

Flags:

- `--mode strict` caps sentences at 20 words. `--mode flavored` caps them at 25.
- `--no-em-dash` also reports em dashes. STE does not ban the em dash, so this is a house-style flag. Use it when the project or the user bans it.
- `--quiet` hides the tier 2 heuristics.

Findings come in two tiers. Tier 1 is mechanical: semicolons, sentence length, contractions, wordy words, and marketing adjectives. Fix every tier 1 finding. Tier 1 sets the exit code. Tier 2 is heuristic: possible passive voice, nominalizations, phrasal verbs, stacked auxiliaries, and "-ing" sentence openers. Read each tier 2 finding and then decide.

The script masks fenced code, inline code spans, headings, and link targets before it checks anything. A backticked identifier therefore does not split a sentence, and a code block does not count as one long sentence. The script does check table cells, because a wide cell is often the longest prose on a reference page.

Then check by hand what the script cannot:

1. Any passive voice with a known actor? Make it active. Tier 2 finds the candidates. Only you know the actor.
2. Same thing named two ways? Pick one name and use it everywhere.
3. Does each word carry one meaning in this text?

Do not run the checker on this SKILL.md. The Rules section quotes the banned words as examples, so each quote reports as a finding.

The mechanical rules above are lintable and are what removes slop. Full STE also needs human judgment (the right technical noun, whether a sentence "makes good sense") — a checker cannot certify that, and slop is not about that. This skill fixes the FORM of slop. It cannot make a hollow paragraph true.

Free official standard (do not paste it in full; it is copyrighted): https://asd-ste100.org