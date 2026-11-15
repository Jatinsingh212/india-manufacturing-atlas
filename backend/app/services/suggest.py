"""ML ministry suggestions for residual HSN lines (docs/SPEC.md section 6.9): unmapped codes classified as
'Residual Products' still need clear product ownership.

Method (a transparent nearest-neighbour vote, labelled "Model estimate" in the API)
-----------------------------------------------------------------------------------
1. **Corpus** - every *accepted* product line (``mapping_status = 'accepted'``, owner not ``residual``); its text is
   the display ``description`` plus the ``full_description`` (heading - subheading - line), so lines of the same
   heading share vocabulary.
2. **Vectors** - two TF-IDF spaces fitted on the corpus: word uni/bi-grams over the full text (sublinear tf,
   English stop words plus HS boiler-plate such as "n.e.c.", "other", "heading") and character 3-5-grams within
   word boundaries over the display description (robust to plurals, hyphenation and spelling variants such as
   "tyre/tire"; using the shorter description keeps the char space small). Each space is L2-normalised and the
   two are concatenated with weight 1/2 each, so a dot product is the mean of the two cosine similarities (0..1).
3. **Neighbours** - cosine similarity of the query line against the corpus (the line itself excluded). Neighbours
   are taken from the **same HS chapter first** (similarity >= :data:`MIN_SIMILARITY`), and the list is filled up
   to :data:`TOP_K` from all chapters when the chapter has too few close lines.
4. **Vote** - each neighbour votes for its ministry with its similarity x a boost (x :data:`SAME_HEADING_BOOST`
   for the same 4-digit heading, x :data:`SAME_CHAPTER_BOOST` for the same chapter). A ministry's ``score`` is
   its share of the total vote (0..1, the scores of all suggested ministries sum to <= 1); ``similar`` lists its
   strongest neighbours as evidence.

Validation: leave-one-out on 500 random accepted lines of the 2026-10-19 build (each line's own row excluded
from the vote; :func:`leave_one_out`, run with ``python -m app.services.suggest``): the top suggestion equals the
current owner for 98.0 % of them (~25 ms per query). Current owners come from the DPIIT Guidebook mapping
(or a later approved upload/claim), so this measures consistency with the mapping, not ground truth.

Caching (in-process, thread-safe)
---------------------------------
The fitted index is keyed on the database file and ``meta.built_at``: it is fitted once per database build
(~4-6 s on the reference machine; the residual router starts the fit in a background thread when the workbench
list or the claims queue is first opened) and queries then take ~60-80 ms. Mapping changes made through the API
(approved claims, applied official uploads) all write ``mapping_changes``; on each use the index replays the
changes newer than the last one it has seen - a newly accepted line is vectorised with the fitted vocabularies
and appended, a changed owner is updated in place - so an approval never triggers a refit. At most
:data:`MAX_CACHED_INDEXES` databases are cached (tests run on temporary copies); the oldest is dropped first.

Public API: :func:`suggest_ministries(conn, hsn8, limit=5)`, :func:`suggest_for_text(conn, text, chapter=None)`,
:func:`get_index(conn)`, :func:`warm_async(db_path)`, :func:`is_cached(conn)`, :func:`clear_cache()`,
:func:`leave_one_out(conn, n=500)`.
"""
from __future__ import annotations

import logging
import random
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer
from sklearn.preprocessing import normalize

from app.common import ministry_refs, normalize_code, provenance
from app.db import connection, in_json, json_param, row, rows, scalar

log = logging.getLogger("atlas.suggest")

TOP_K = 15                  # neighbours that vote
MIN_SIMILARITY = 0.08       # a same-chapter neighbour below this does not count as "close"
SAME_CHAPTER_BOOST = 1.25
SAME_HEADING_BOOST = 1.6    # applied instead of (not on top of) the chapter boost
SIMILAR_PER_MINISTRY = 3
WORD_WEIGHT = 0.5           # weight of the word space; the char space gets 1 - WORD_WEIGHT
MAX_CACHED_INDEXES = 3      # distinct database files kept in memory
INACTIVE = ""               # ministry_id of a corpus row whose line is no longer accepted (never votes)

#: Generic HS vocabulary that says nothing about the product domain.
HS_STOP_WORDS = frozenset({
    "nec", "heading", "headings", "subheading", "subheadings", "item", "items", "no", "nos",
    "other", "others", "otherwise", "excluding", "including", "include", "whether", "kind", "kinds", "used",
    "chapter", "note", "notes", "thereof", "parts", "part", "articles", "article", "similar", "specified",
    "elsewhere", "mentioned", "form", "forms", "etc", "type", "types",
})
_STOP_WORDS = sorted(set(ENGLISH_STOP_WORDS) | HS_STOP_WORDS)
_TOKEN = r"(?u)\b[a-zA-Z][a-zA-Z]+\b"   # words only - codes inside descriptions would link unrelated lines
_NON_WORD = re.compile(r"[^\w\s-]+", re.UNICODE)
_CORPUS_SQL = """
    SELECT hsn8, hs2, hs4, ministry_id, mapping_status, description,
           COALESCE(full_description, '') AS full_description
    FROM products"""

METHOD = {
    "name": "TF-IDF nearest-neighbour vote",
    "features": "word 1-2-grams (full text) + character 3-5-grams (description), TF-IDF, equal weight",
    "neighbours": f"top {TOP_K} accepted lines, same HS chapter first (cosine >= {MIN_SIMILARITY}), then all",
    "boosts": {"same_heading": SAME_HEADING_BOOST, "same_chapter": SAME_CHAPTER_BOOST},
    "score": "ministry share of the similarity-weighted vote (0..1)",
}


def _clean(text: str | None) -> str:
    """Lower-case and drop punctuation ("n.e.c." -> "nec") before vectorising."""
    text = (text or "").lower().replace("n.e.c.", " nec ").replace("n.e.s.", " nec ")
    return _NON_WORD.sub(" ", text)


def _texts(r: dict) -> tuple[str, str]:
    """(full text for the word space, display description for the char space) of a product row."""
    return _clean(f"{r['description']} {r['full_description']}"), _clean(r["description"])


@dataclass
class SuggestIndex:
    """A fitted corpus: vectorizers, the stacked document matrix and per-line metadata."""

    key: tuple
    hsn8: list[str]
    hs2: list[str]
    hs4: list[str]
    ministry_id: list[str]
    description: list[str]
    word_vectorizer: TfidfVectorizer
    char_vectorizer: TfidfVectorizer
    matrix: sparse.csr_matrix
    last_change_id: int = 0
    fitted_at: float = field(default_factory=time.time)
    fit_seconds: float = 0.0
    position: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.position = {code: i for i, code in enumerate(self.hsn8)}

    @property
    def size(self) -> int:
        """Number of lines that currently vote (accepted lines)."""
        return sum(1 for m in self.ministry_id if m != INACTIVE)

    def vectorize(self, full_texts: list[str], short_texts: list[str] | None = None) -> sparse.csr_matrix:
        """Project texts into the stacked (word | char) space used by :attr:`matrix`.

        ``full_texts`` feed the word space and ``short_texts`` (display descriptions; default: the same texts)
        the character space - mirroring how the corpus was fitted.
        """
        short_texts = full_texts if short_texts is None else short_texts
        word = normalize(self.word_vectorizer.transform([_clean(t) for t in full_texts]))
        char = normalize(self.char_vectorizer.transform([_clean(t) for t in short_texts]))
        return sparse.hstack([word * np.sqrt(WORD_WEIGHT), char * np.sqrt(1.0 - WORD_WEIGHT)], format="csr")

    def apply_changes(self, conn: sqlite3.Connection) -> int:
        """Replay ``mapping_changes`` newer than :attr:`last_change_id`; returns the number of lines touched."""
        last = int(scalar(conn, "SELECT MAX(id) FROM mapping_changes", default=0) or 0)
        if last <= self.last_change_id:
            return 0
        codes = [r["hsn8"] for r in rows(conn, "SELECT DISTINCT hsn8 FROM mapping_changes WHERE id > ?",
                                         (self.last_change_id,))]
        current = rows(conn, f"{_CORPUS_SQL} WHERE {in_json('hsn8')}", (json_param(codes),)) if codes else []
        new_rows = []
        for r in current:
            accepted = r["mapping_status"] == "accepted" and r["ministry_id"] not in (None, "", "residual")
            i = self.position.get(r["hsn8"])
            if i is not None:
                self.ministry_id[i] = r["ministry_id"] if accepted else INACTIVE
            elif accepted:
                new_rows.append(r)
        if new_rows:
            texts = [_texts(r) for r in new_rows]
            block = self.vectorize([t[0] for t in texts], [t[1] for t in texts])
            self.matrix = sparse.vstack([self.matrix, block], format="csr")
            for r in new_rows:
                self.position[r["hsn8"]] = len(self.hsn8)
                self.hsn8.append(r["hsn8"])
                self.hs2.append(r["hs2"])
                self.hs4.append(r["hs4"])
                self.ministry_id.append(r["ministry_id"])
                self.description.append(r["description"])
        self.last_change_id = last
        log.info("suggest index: replayed mapping changes up to #%d (%d lines, %d appended)", last, len(current),
                 len(new_rows))
        return len(current)


_cache: dict[str, SuggestIndex] = {}
_warming: set[str] = set()
_fit_locks: dict[str, threading.Lock] = {}
_lock = threading.Lock()


def _db_file(conn: sqlite3.Connection) -> str:
    for r in conn.execute("PRAGMA database_list").fetchall():
        name, file = (r.get("name"), r.get("file")) if isinstance(r, dict) else (r[1], r[2])
        if name == "main":
            return str(Path(file).resolve()) if file else ":memory:"
    return ":memory:"


def _cache_key(conn: sqlite3.Connection) -> tuple:
    built_at = scalar(conn, "SELECT value FROM meta WHERE key = 'built_at'", default="")
    return (_db_file(conn), built_at)


def _fit(conn: sqlite3.Connection, key: tuple) -> SuggestIndex:
    start = time.perf_counter()
    last_change = int(scalar(conn, "SELECT MAX(id) FROM mapping_changes", default=0) or 0)
    data = rows(conn, f"{_CORPUS_SQL} WHERE mapping_status = 'accepted' AND ministry_id <> 'residual' ORDER BY hsn8")
    if not data:
        raise LookupError("no accepted product lines to learn from")
    texts = [_texts(r) for r in data]
    word_vectorizer = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, sublinear_tf=True,
                                      stop_words=_STOP_WORDS, token_pattern=_TOKEN, dtype=np.float32)
    char_vectorizer = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, sublinear_tf=True,
                                      max_features=150_000, dtype=np.float32)
    word = normalize(word_vectorizer.fit_transform([t[0] for t in texts])) * np.sqrt(WORD_WEIGHT)
    char = normalize(char_vectorizer.fit_transform([t[1] for t in texts])) * np.sqrt(1.0 - WORD_WEIGHT)
    index = SuggestIndex(
        key=key, hsn8=[r["hsn8"] for r in data], hs2=[r["hs2"] for r in data], hs4=[r["hs4"] for r in data],
        ministry_id=[r["ministry_id"] for r in data], description=[r["description"] for r in data],
        word_vectorizer=word_vectorizer, char_vectorizer=char_vectorizer,
        matrix=sparse.hstack([word, char], format="csr"), last_change_id=last_change)
    index.fit_seconds = round(time.perf_counter() - start, 3)
    log.info("suggest index fitted on %d lines in %.2fs", len(index.hsn8), index.fit_seconds)
    return index


def _fit_lock(db_file: str) -> threading.Lock:
    """The lock that serialises fits of one database file (so a request waits for a running warm-up)."""
    with _lock:
        lock = _fit_locks.get(db_file)
        if lock is None:
            lock = _fit_locks[db_file] = threading.Lock()
        return lock


def _cached(conn: sqlite3.Connection, key: tuple) -> SuggestIndex | None:
    """The cached index for ``key`` (brought up to date with ``mapping_changes``), else None."""
    with _lock:
        cached = _cache.get(key[0])
        if cached is not None and cached.key == key:
            cached.apply_changes(conn)
            return cached
    return None


def get_index(conn: sqlite3.Connection) -> SuggestIndex:
    """The fitted index for this database (fitted on first use, then cached and kept in sync).

    Fits of the same database file are serialised by a per-file lock: a request that arrives while the
    background warm-up (or another request) is fitting waits for that fit instead of starting a second,
    competing one. Fits of different files (test copies) do not block each other or cached queries.
    """
    key = _cache_key(conn)
    cached = _cached(conn, key)
    if cached is not None:
        return cached
    with _fit_lock(key[0]):
        cached = _cached(conn, key)  # a concurrent fit may have finished while we waited
        if cached is not None:
            return cached
        index = _fit(conn, key)
        with _lock:
            index.apply_changes(conn)
            _cache.pop(key[0], None)
            _cache[key[0]] = index
            while len(_cache) > MAX_CACHED_INDEXES:  # dicts keep insertion order: drop the oldest fit
                _cache.pop(next(iter(_cache)))
        return index


def is_cached(conn: sqlite3.Connection) -> bool:
    """True when the index for the current database build is already fitted."""
    key = _cache_key(conn)
    cached = _cache.get(key[0])
    return cached is not None and cached.key == key


def warm_async(db_path: str | Path) -> threading.Thread | None:
    """Fit the index for ``db_path`` in a daemon thread (own connection) unless it is already warming.

    Best effort: a failure is logged and the next suggestion request simply fits synchronously.
    """
    key = str(Path(db_path).resolve())
    with _lock:
        if key in _warming:
            return None
        _warming.add(key)

    def _run() -> None:
        try:
            with connection(db_path) as conn:
                get_index(conn)
        except Exception as exc:  # noqa: BLE001 - warming must never raise
            log.warning("suggest index warm-up failed: %s", exc)
        finally:
            with _lock:
                _warming.discard(key)

    thread = threading.Thread(target=_run, name="atlas-suggest-warmup", daemon=True)
    thread.start()
    return thread


def clear_cache() -> None:
    """Drop every fitted index (tests; after bulk mapping changes made outside the API)."""
    with _lock:
        _cache.clear()


def _neighbours(index: SuggestIndex, sims: np.ndarray, hs2: str | None, exclude: str | None) -> list[int]:
    """Indices of the voting neighbours: same chapter first (close ones), then the best of all chapters."""
    if exclude is not None and exclude in index.position:
        sims[index.position[exclude]] = -1.0
    inactive = [i for i, m in enumerate(index.ministry_id) if m == INACTIVE]
    if inactive:
        sims[inactive] = -1.0
    order = np.argsort(-sims, kind="stable")
    chosen: list[int] = []
    if hs2:
        same = [int(i) for i in order[: max(TOP_K * 40, 400)]
                if index.hs2[i] == hs2 and sims[i] >= MIN_SIMILARITY]
        chosen = same[:TOP_K]
    if len(chosen) < TOP_K:
        taken = set(chosen)
        for i in order:
            if len(chosen) >= TOP_K or sims[i] <= 0:
                break
            if int(i) not in taken:
                chosen.append(int(i))
    return chosen


def _vote(conn: sqlite3.Connection, index: SuggestIndex, sims: np.ndarray, neighbours: list[int],
          hs2: str | None, hs4: str | None, limit: int) -> list[dict]:
    votes: dict[str, float] = {}
    evidence: dict[str, list[dict]] = {}
    for i in neighbours:
        sim = float(sims[i])
        if sim <= 0 or index.ministry_id[i] == INACTIVE:
            continue
        if hs4 and index.hs4[i] == hs4:
            weight = sim * SAME_HEADING_BOOST
        elif hs2 and index.hs2[i] == hs2:
            weight = sim * SAME_CHAPTER_BOOST
        else:
            weight = sim
        ministry = index.ministry_id[i]
        votes[ministry] = votes.get(ministry, 0.0) + weight
        evidence.setdefault(ministry, []).append({
            "hsn8": index.hsn8[i], "description": index.description[i], "similarity": round(sim, 4),
            "same_chapter": bool(hs2 and index.hs2[i] == hs2), "same_heading": bool(hs4 and index.hs4[i] == hs4)})
    total = sum(votes.values())
    if total <= 0:
        return []
    ranked = sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    refs = {m["id"]: m for m in ministry_refs(conn, [m for m, _ in ranked])}
    out = []
    for ministry_id, vote in ranked:
        similar = sorted(evidence[ministry_id], key=lambda e: -e["similarity"])
        out.append({"ministry": refs.get(ministry_id) or {"id": ministry_id, "short_name": ministry_id,
                                                          "name": ministry_id, "color": None},
                    "score": round(vote / total, 4), "n_similar": len(similar),
                    "similar": similar[:SIMILAR_PER_MINISTRY]})
    return out


def suggest_for_text(conn: sqlite3.Connection, text: str, chapter: str | None = None, *,
                     heading: str | None = None, exclude_hsn8: str | None = None, limit: int = 5,
                     short_text: str | None = None, index: SuggestIndex | None = None) -> list[dict]:
    """Ministry suggestions for free text, optionally anchored to an HS chapter / heading.

    ``short_text`` is the product's display description for the character space (default: ``text``).
    """
    index = index or get_index(conn)
    query = index.vectorize([text], [short_text if short_text is not None else text])
    sims = np.asarray((index.matrix @ query.T).todense(), dtype=np.float64).ravel()
    neighbours = _neighbours(index, sims, chapter, exclude_hsn8)
    return _vote(conn, index, sims, neighbours, chapter, heading, limit)


def suggest_ministries(conn: sqlite3.Connection, hsn8: str, limit: int = 5) -> dict | None:
    """``{hsn8, description, mapping_status, current_ministry_id, suggestions, method, provenance}`` or None.

    ``suggestions`` = ``[{ministry: MinistryRef, score, n_similar, similar: [{hsn8, description, similarity,
    same_chapter, same_heading}]}]`` (SPEC 6.9; ``n_similar`` / ``similarity`` / ``same_*`` are extras).
    """
    code = normalize_code(hsn8)
    product = row(conn, f"{_CORPUS_SQL} WHERE hsn8 = ?", (code,))
    if not product:
        return None
    index = get_index(conn)
    full, short = _texts(product)
    suggestions = suggest_for_text(conn, full, product["hs2"], heading=product["hs4"], exclude_hsn8=product["hsn8"],
                                   limit=limit, short_text=short, index=index)
    return {
        "hsn8": product["hsn8"],
        "description": product["description"],
        "mapping_status": product["mapping_status"],
        "current_ministry_id": product["ministry_id"],
        "suggestions": suggestions,
        "method": {**METHOD, "corpus_size": index.size, "fit_seconds": index.fit_seconds},
        "provenance": provenance("model", "not_verified",
                                 "Model estimate (TF-IDF similarity to accepted lines) - see /about#methodology"),
    }


def leave_one_out(conn: sqlite3.Connection, n: int = 500, seed: int = 42) -> dict:
    """Agreement of the top suggestion with the current owner on ``n`` random accepted lines (own row excluded)."""
    index = get_index(conn)
    active = [i for i, m in enumerate(index.ministry_id) if m != INACTIVE]
    sample = random.Random(seed).sample(active, min(n, len(active)))
    hits, start = 0, time.perf_counter()
    for i in sample:
        sims = np.asarray((index.matrix @ index.matrix[i].T).todense(), dtype=np.float64).ravel()
        neighbours = _neighbours(index, sims, index.hs2[i], index.hsn8[i])
        votes = _vote(conn, index, sims, neighbours, index.hs2[i], index.hs4[i], 1)
        hits += bool(votes) and votes[0]["ministry"]["id"] == index.ministry_id[i]
    return {"n": len(sample), "top1_agreement": round(hits / len(sample), 4) if sample else None,
            "ms_per_query": round((time.perf_counter() - start) * 1000 / max(1, len(sample)), 1)}


__all__ = ["SuggestIndex", "suggest_ministries", "suggest_for_text", "get_index", "warm_async", "is_cached",
           "clear_cache", "leave_one_out", "METHOD"]


if __name__ == "__main__":  # python -m app.services.suggest  -> leave-one-out check on the configured database
    with connection() as _conn:
        print(leave_one_out(_conn))
