#!/usr/bin/env python3
"""Mechanical ASD-STE100 checks for prose files.

Tier 1 findings are mechanical and set the exit code.
Tier 2 findings are heuristic and advisory only.

The script masks code before it checks anything: fenced blocks, inline code
spans, headings, HTML comments, and link targets. Masking keeps a backticked
identifier such as `Users.Id` from splitting a sentence, and keeps a code block
from counting as one long sentence.

Table rows are checked, not skipped. A wide table cell is often the longest
prose on a reference page.
"""

import argparse
import re
import sys

MODE_CAPS = {"strict": 20, "flavored": 25}

CODE_PLACEHOLDER = "CODE"

ABBREVIATIONS = {
    "e.g.", "i.e.", "vs.", "etc.", "cf.", "approx.", "no.", "fig.",
    "Mr.", "Ms.", "Dr.", "St.", "Inc.", "Ltd.", "Co.",
}

CONTRACTIONS = re.compile(
    r"\b(?:\w+n't"
    r"|\w+'(?:re|ll|ve|m)"
    r"|(?:it|that|there|let|what|who|he|she|here|one)'s"
    r")\b",
    re.IGNORECASE,
)

WORDY_WORDS = [
    ("utilize", "use"), ("utilise", "use"), ("utilization", "use"),
    ("leverage", "use"), ("facilitate", "help"), ("ensure", "make sure"),
    ("prior to", "before"), ("subsequent to", "after"),
    ("regarding", "about"), ("concerning", "about"),
    ("obtain", "get"), ("acquire", "get"),
    ("demonstrate", "show"), ("commence", "start"), ("initiate", "start"),
    ("additionally", "also"), ("furthermore", "also"), ("moreover", "also"),
    ("in the event that", "if"), ("at this point in time", "now"),
]

MARKETING_WORDS = [
    "seamless", "seamlessly", "robust", "powerful", "cutting-edge",
    "effortless", "effortlessly", "world-class", "next-generation",
    "revolutionary", "game-changing", "blazing", "state-of-the-art",
    "best-in-class", "turnkey",
]

PASSIVE = re.compile(
    r"\b(?:is|are|was|were|be|been|being)\s+"
    r"(?:\w+ed|done|made|given|taken|seen|known|shown|built|held|sent|kept|"
    r"left|found|set|written|read|drawn|thrown|chosen)\b",
    re.IGNORECASE,
)

NOMINALIZATIONS = [
    r"\b(?:perform|conduct|carry out|make|do)\s+(?:a|an|the)\s+\w+(?:tion|sion|sis|ment|ance|ence)\b",
    r"\bmake use of\b",
    r"\bis able to\b",
    r"\bin order to\b",
    r"\bit is important to note\b",
    r"\bit should be noted\b",
    r"\bthe purpose of this\b",
]

PHRASAL_VERBS = [
    "spin up", "spun up", "kick off", "kicks off", "ramp up", "reach out",
    "drill down", "dive into", "circle back", "touch base", "tear down",
    "stand up", "dial in",
]

STACKED_AUXILIARIES = re.compile(
    r"\b(?:may|might|could|should|would|can|will)\s+(?:help(?:\s+to)?|be\s+able\s+to|"
    r"potentially|possibly)\b",
    re.IGNORECASE,
)


class Finding:
    def __init__(self, line, tier, code, message):
        self.line = line
        self.tier = tier
        self.code = code
        self.message = message


def mask_inline(text):
    """Replace inline code, link targets, and images with plain placeholders."""
    text = re.sub(r"`[^`]*`", CODE_PLACEHOLDER, text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>\s]+@[^>\s]+>|<https?://[^>]*>", CODE_PLACEHOLDER, text)
    text = re.sub(r"https?://\S+", CODE_PLACEHOLDER, text)
    return text


def strip_emphasis(text):
    text = re.sub(r"\*\*([^*]*)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"(?<!_)_([^_]+)_(?!_)", r"\1", text)
    return text


def is_table_delimiter(line):
    return bool(re.match(r"^\s*\|?[\s:|-]+\|?\s*$", line)) and "-" in line


def is_table_row(line):
    return line.lstrip().startswith("|")


def is_list_item(line):
    return bool(re.match(r"^\s*(?:[-*+]\s|\d+[.)]\s)", line))


def extract_units(lines):
    """Return (line_number, prose_text) units with code and headings removed.

    A unit is one paragraph, one list item, or one table cell. Sentences never
    cross a unit boundary, so each unit can be split into sentences on its own.
    """
    units = []
    paragraph = []
    paragraph_line = 0
    in_fence = False
    fence_marker = ""

    def flush():
        nonlocal paragraph, paragraph_line
        if paragraph:
            units.append((paragraph_line, " ".join(paragraph)))
        paragraph = []
        paragraph_line = 0

    for number, raw in enumerate(lines, start=1):
        line = raw.rstrip("\n")
        stripped = line.strip()

        fence = re.match(r"^\s*(`{3,}|~{3,})", line)
        if in_fence:
            if fence and stripped.startswith(fence_marker):
                in_fence = False
            continue
        if fence:
            flush()
            in_fence = True
            fence_marker = fence.group(1)[:3]
            continue

        if not stripped:
            flush()
            continue
        if re.match(r"^\s{4,}\S", line) and not paragraph:
            continue  # indented code block
        if stripped.startswith("#"):
            flush()
            continue
        if stripped.startswith("<!--") or stripped.endswith("-->"):
            flush()
            continue
        if re.match(r"^\s*(?:[-*_]\s*){3,}$", line):
            flush()
            continue

        if is_table_row(line):
            flush()
            if is_table_delimiter(line):
                continue
            for cell in line.strip().strip("|").split("|"):
                if cell.strip():
                    units.append((number, cell.strip()))
            continue

        if is_list_item(line):
            flush()
            paragraph_line = number
            paragraph.append(re.sub(r"^\s*(?:[-*+]\s|\d+[.)]\s)", "", line))
            continue

        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ")
        if not paragraph:
            paragraph_line = number
        paragraph.append(stripped)

    flush()
    return units


def split_sentences(text):
    parts = re.split(r"(?<=[.!?])[\"')\]]*\s+", text)
    sentences = []
    for part in parts:
        if sentences and ends_with_abbreviation(sentences[-1]):
            sentences[-1] = sentences[-1] + " " + part
        else:
            sentences.append(part)
    return [s.strip() for s in sentences if s.strip()]


def ends_with_abbreviation(sentence):
    tail = sentence.split()[-1] if sentence.split() else ""
    if tail in ABBREVIATIONS:
        return True
    return bool(re.search(r"\b[A-Za-z]\.$", tail)) and len(tail) <= 3


def count_words(sentence):
    tokens = re.findall(r"[^\s]+", sentence)
    return len([t for t in tokens if re.search(r"[A-Za-z0-9]", t)])


def check_units(units, cap):
    findings = []
    for line, raw_unit in units:
        unit = strip_emphasis(mask_inline(raw_unit))

        for match in re.finditer(r";", unit):
            findings.append(Finding(line, 1, "semicolon",
                                    "Semicolon. Write two sentences."))
            del match

        for match in CONTRACTIONS.finditer(unit):
            findings.append(Finding(line, 1, "contraction",
                                    'Contraction "%s". Expand it.' % match.group(0)))

        lowered = unit.lower()
        for word, better in WORDY_WORDS:
            for match in re.finditer(r"\b%s\b" % re.escape(word), lowered):
                findings.append(Finding(line, 1, "wordy",
                                        'Use "%s", not "%s".' % (better, word)))
                del match
        for word in MARKETING_WORDS:
            for match in re.finditer(r"\b%s\b" % re.escape(word), lowered):
                findings.append(Finding(line, 1, "marketing",
                                        'Marketing adjective "%s". Delete it or state the fact.' % word))
                del match

        for sentence in split_sentences(unit):
            words = count_words(sentence)
            if words > cap:
                findings.append(Finding(line, 1, "length",
                                        "Sentence of %d words, over the %d word cap: %s"
                                        % (words, cap, shorten(sentence))))

            if words < 4:
                continue  # a table header or a stub, not prose

            match = PASSIVE.search(sentence)
            if match:
                findings.append(Finding(line, 2, "passive",
                                        'Possible passive voice "%s". Name the actor.'
                                        % match.group(0)))
            for pattern in NOMINALIZATIONS:
                match = re.search(pattern, sentence, re.IGNORECASE)
                if match:
                    findings.append(Finding(line, 2, "nominalization",
                                            'Wordy construction "%s". Use a plain verb.'
                                            % match.group(0)))
            for phrase in PHRASAL_VERBS:
                if re.search(r"\b%s\b" % re.escape(phrase), sentence, re.IGNORECASE):
                    findings.append(Finding(line, 2, "phrasal-verb",
                                            'Phrasal verb "%s". Use one plain verb.' % phrase))
            match = STACKED_AUXILIARIES.search(sentence)
            if match:
                findings.append(Finding(line, 2, "stacked-auxiliary",
                                        'Stacked auxiliaries "%s". State the effect directly.'
                                        % match.group(0)))
            match = re.match(r"^(\w+ing)\b", sentence)
            if match and match.group(1).lower() not in ("during", "nothing", "something",
                                                        "anything", "everything", "string",
                                                        "using", "being"):
                findings.append(Finding(line, 2, "ing-verb",
                                        'Sentence starts with "%s". A simple tense may be clearer.'
                                        % match.group(1)))
    return findings


def fenced_line_numbers(lines):
    """Line numbers inside fenced code blocks, including the fence lines."""
    inside = set()
    in_fence = False
    marker = ""
    for number, raw in enumerate(lines, start=1):
        fence = re.match(r"^\s*(`{3,}|~{3,})", raw)
        if in_fence:
            inside.add(number)
            if fence and raw.strip().startswith(marker):
                in_fence = False
            continue
        if fence:
            in_fence = True
            marker = fence.group(1)[:3]
            inside.add(number)
    return inside


def check_em_dash(lines):
    """Report em dashes outside code. An em dash in code is literal content."""
    findings = []
    skip = fenced_line_numbers(lines)
    for number, line in enumerate(lines, start=1):
        if number in skip:
            continue
        if "—" in mask_inline(line):
            findings.append(Finding(number, 1, "em-dash",
                                    "Em dash. Use a comma, parentheses, or a full stop."))
    return findings


def shorten(text, limit=70):
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def lint(path, cap, ban_em_dash):
    with open(path, encoding="utf-8") as handle:
        lines = handle.readlines()
    findings = check_units(extract_units(lines), cap)
    if ban_em_dash:
        findings.extend(check_em_dash(lines))
    findings.sort(key=lambda f: (f.line, f.tier, f.code))
    return findings


def main():
    parser = argparse.ArgumentParser(
        description="Mechanical Simplified Technical English checks.")
    parser.add_argument("paths", nargs="+", help="files to check")
    parser.add_argument("--mode", choices=sorted(MODE_CAPS), default="flavored",
                        help="strict caps sentences at 20 words, flavored at 25 "
                             "(default: flavored)")
    parser.add_argument("--no-em-dash", action="store_true",
                        help="also report em dashes as tier 1. STE does not ban "
                             "the em dash, so this is a house-style flag.")
    parser.add_argument("--quiet", action="store_true",
                        help="report tier 1 only")
    args = parser.parse_args()

    cap = MODE_CAPS[args.mode]
    tier1_total = 0
    tier2_total = 0
    errors = 0

    for path in args.paths:
        try:
            findings = lint(path, cap, args.no_em_dash)
        except OSError as error:
            print("%s: cannot read the file: %s" % (path, error), file=sys.stderr)
            errors += 1
            continue

        for finding in findings:
            if finding.tier == 2 and args.quiet:
                continue
            print("%s:%d: [tier %d %s] %s"
                  % (path, finding.line, finding.tier, finding.code, finding.message))
        tier1_total += len([f for f in findings if f.tier == 1])
        tier2_total += len([f for f in findings if f.tier == 2])

    print("\n%d tier 1 finding(s), %d tier 2 finding(s). Mode: %s, cap %d words."
          % (tier1_total, tier2_total, args.mode, cap))
    if tier1_total:
        print("Tier 1 findings are mechanical. Fix them.")
    if tier2_total and not args.quiet:
        print("Tier 2 findings are heuristic. Read them, then decide.")
    if errors:
        print("%d file(s) could not be read." % errors)
    return 1 if (tier1_total or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
