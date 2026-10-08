#!/usr/bin/env python3
"""Check that every i18n key used by the extension exists in both catalogues.

Reads the extension sources, collects every key referenced through
`chrome.i18n.getMessage("key")`, the `t("key")` helper, and the
`__MSG_key__` placeholders Chrome substitutes in manifest.json / popup.html,
then asserts that _locales/en (the default locale) and _locales/zh_CN define
exactly the same set of keys and that no referenced key is missing.

Run from anywhere:  python extension/check-i18n-keys.py
Exit code 0 means every reference resolves; 1 means something is missing.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EXTENSION = Path(__file__).resolve().parent
LOCALES = EXTENSION / "_locales"
LOCALE_NAMES = ("en", "zh_CN")

# getMessage("x") / getMessage('x') / getMessage(`x`)
GET_MESSAGE_RE = re.compile(r"""getMessage\(\s*["'`]([^"'`]+)["'`]""")
# The local t("x") helper: a bare call with a quoted literal first argument.
T_HELPER_RE = re.compile(r"""(?<![\w.$])t\(\s*["'`]([^"'`]+)["'`]""")
# __MSG_x__ placeholders, which Chrome substitutes in manifest.json only.
PLACEHOLDER_RE = re.compile(r"__MSG_([A-Za-z0-9_@]+)__")
# Static markup carries its message key in a data-i18n* attribute because Chrome
# does NOT substitute __MSG_*__ in extension HTML pages.
DATA_I18N_RE = re.compile(
    r"""data-i18n(?:-placeholder|-title|-aria-label|-alt)?=["']([A-Za-z0-9_@]+)["']"""
)

SOURCE_FILES = (
    "manifest.json",
    "popup.html",
    "popup.js",
    "background.js",
    "region-shield-main.js",
    "region-shield-bridge.js",
)


def load_catalogues() -> dict[str, dict]:
    catalogues: dict[str, dict] = {}
    for name in LOCALE_NAMES:
        path = LOCALES / name / "messages.json"
        if not path.is_file():
            print(f"FAIL  missing catalogue: {path.relative_to(EXTENSION.parent)}", file=sys.stderr)
            raise SystemExit(1)
        try:
            catalogues[name] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            print(f"FAIL  {path} is not valid JSON: {type(exc).__name__}", file=sys.stderr)
            raise SystemExit(1)
    return catalogues


def collect_references() -> dict[str, set[str]]:
    """Map key -> set of 'file:line' references."""
    references: dict[str, set[str]] = {}

    def record(key: str, where: str) -> None:
        references.setdefault(key, set()).add(where)

    for name in SOURCE_FILES:
        path = EXTENSION / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), start=1):
            where = f"{name}:{number}"
            for match in PLACEHOLDER_RE.finditer(line):
                record(match.group(1), where)
            for match in DATA_I18N_RE.finditer(line):
                record(match.group(1), where)
            for match in GET_MESSAGE_RE.finditer(line):
                record(match.group(1), where)
            for match in T_HELPER_RE.finditer(line):
                record(match.group(1), where)
    return references


def main() -> int:
    catalogues = load_catalogues()
    references = collect_references()
    en, zh = catalogues["en"], catalogues["zh_CN"]
    failures: list[str] = []

    print(f"catalogues: en={len(en)} keys, zh_CN={len(zh)} keys")
    only_en = sorted(set(en) - set(zh))
    only_zh = sorted(set(zh) - set(en))
    if only_en:
        failures.append(f"keys only in en: {only_en}")
    if only_zh:
        failures.append(f"keys only in zh_CN: {only_zh}")
    print(f"key parity: {'OK' if not only_en and not only_zh else 'MISMATCH'}")

    for name, catalogue in catalogues.items():
        bad = sorted(key for key, value in catalogue.items() if not isinstance(value, dict) or not value.get("message"))
        if bad:
            failures.append(f"{name}: entries without a non-empty message field: {bad}")
    print("message field present in every entry: " + ("OK" if not failures else "see failures"))

    missing = sorted(key for key in references if key not in en)
    for key in missing:
        failures.append(f"referenced but not defined in en: {key} ({', '.join(sorted(references[key]))})")
    print(f"referenced keys: {len(references)}; missing from en: {len(missing)}")

    unused = sorted(set(en) - set(references))
    if unused:
        print(f"note: {len(unused)} defined key(s) are not referenced by a literal call:")
        for key in unused:
            print(f"  - {key}")

    # A Chinese string must never leak into an English message, and an English
    # message must never leak into the Chinese catalogue. Only compare pairs
    # where the English side is genuinely prose: symbol-only messages (" ✓")
    # and identifier-like messages ("example.com") are identical in both.
    cjk = re.compile(r"[\u4e00-\u9fff]")
    for key in sorted(set(en) & set(zh)):
        en_text = en[key].get("message", "")
        zh_text = zh[key].get("message", "")
        if cjk.search(en_text):
            failures.append(f"en/{key} contains CJK characters")
        if en_text != zh_text and not cjk.search(zh_text):
            failures.append(f"zh_CN/{key} has no Chinese text but differs from en: {zh_text!r}")
    print("locale text purity (no CJK in en, zh_CN actually translated): checked")

    # The English UI must not inherit Chinese punctuation.
    cn_punctuation = re.compile(r"[，。：；！？（）【】、“”‘’]")
    for key, value in sorted(en.items()):
        found = cn_punctuation.findall(value.get("message", ""))
        if found:
            failures.append(f"en/{key} uses Chinese punctuation: {''.join(sorted(set(found)))}")
    print("english punctuation (no full-width CJK punctuation): checked")

    # $1..$n must be declared, must be used, and must agree across locales --
    # a mismatched index silently renders the wrong value.
    for name, catalogue in catalogues.items():
        for key, value in sorted(catalogue.items()):
            used = set(re.findall(r"\$(\d)", value.get("message", "")))
            declared = set((value.get("placeholders") or {}).keys())
            if used - declared:
                failures.append(f"{name}/{key} uses undeclared placeholder(s) {sorted(used - declared)}")
            if declared - used:
                failures.append(f"{name}/{key} declares unused placeholder(s) {sorted(declared - used)}")
    for key in sorted(set(en) & set(zh)):
        a = sorted(set(re.findall(r"\$(\d)", en[key].get("message", ""))))
        b = sorted(set(re.findall(r"\$(\d)", zh[key].get("message", ""))))
        if a != b:
            failures.append(f"{key} placeholder indices differ: en={a} zh_CN={b}")
    print("placeholder declarations (used, declared, locale-consistent): checked")

    # Chrome truncates the manifest messages, so over-long ones are a real bug.
    for key, limit in (("extName", 75), ("extShortName", 12), ("extDescription", 132)):
        if key not in en:
            failures.append(f"manifest message {key} is missing from en")
            continue
        length = len(en[key]["message"])
        if length > limit:
            failures.append(f"en/{key} is {length} characters, over Chrome's {limit}-character limit")
    print("manifest message lengths (extName/extShortName/extDescription): checked")

    if failures:
        print("\nFAILURES:", file=sys.stderr)
        for line in failures:
            print(f"- {line}", file=sys.stderr)
        return 1
    print("\nPASS: every referenced key exists in both catalogues and key sets are identical.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
