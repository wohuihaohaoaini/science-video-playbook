"""Check every DOI in a references JSON against Crossref and flag mismatches.

  python tools/verify_doi.py script/references.json

references.json: [{"id": 1, "authors": ["Moore", ...], "title": "...", "journal": "...",
                   "year": 2013, "volume": "64", "issue": "", "pages": "637-663", "doi": "10.1146/..."}]
Exit code 1 if any field disagrees; the report says which. Crossref is occasionally wrong too
(e.g. Onda 2008 pages), so a mismatch means "look it up on PubMed / the publisher", not "auto-fix".
After checking by hand, list the field in "crossref_known_issues" with a "note" giving your source.
"""
import json
import re
import ssl
import sys
import urllib.error
import urllib.request

import certifi

# python.org builds on macOS ship without root certificates; use certifi's bundle.
CTX = ssl.create_default_context(cafile=certifi.where())


def norm(s):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'<[^>]+>', '', str(s)).lower())


def crossref(doi):
    req = urllib.request.Request(f'https://doi.org/{doi}', headers={
        'Accept': 'application/vnd.citationstyles.csl+json', 'User-Agent': 'sci-video-pipeline/1.0 (reference check)'})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        return json.load(r)


def main(path):
    refs = json.load(open(path, encoding='utf-8'))
    bad = 0
    for ref in refs:
        try:
            cr = crossref(ref['doi'])
        except urllib.error.HTTPError as e:
            print(f"[{ref['id']}] DOI does not resolve (HTTP {e.code}): {ref['doi']}")
            bad += 1
            continue
        except Exception as e:  # noqa: BLE001  network / TLS problem, not a bad DOI
            print(f"[{ref['id']}] could not reach doi.org ({e}); check network/certificates, the DOI itself is unverified")
            bad += 1
            continue
        issues = []
        if norm(cr.get('title', ''))[:60] != norm(ref['title'])[:60]:
            issues.append(f"title: crossref={re.sub('<[^>]+>', '', cr.get('title', ''))!r}")
        if norm(cr.get('container-title', '')) != norm(ref['journal']):
            issues.append(f"journal: crossref={cr.get('container-title')!r}")
        year = (cr.get('issued', {}).get('date-parts') or [[None]])[0][0]
        if year and int(year) != int(ref['year']):
            issues.append(f'year: crossref={year} (online-first vs print? check)')
        for k_ref, k_cr in [('volume', 'volume'), ('issue', 'issue'), ('pages', 'page')]:
            if ref.get(k_ref) and cr.get(k_cr) and norm(ref[k_ref]) != norm(cr[k_cr]):
                issues.append(f'{k_ref}: crossref={cr[k_cr]!r} vs yours={ref[k_ref]!r}')
        fam = [a.get('family', '') for a in cr.get('author', [])]
        if ref.get('authors') and fam and norm(fam[0]) != norm(ref['authors'][0]):
            issues.append(f'first author: crossref={fam[0]!r}')
        known = set(ref.get('crossref_known_issues', []))
        open_issues = [i for i in issues if i.split(':')[0] not in known]
        acked = [i for i in issues if i.split(':')[0] in known]
        print(f"[{ref['id']}] {'OK' if not open_issues else 'CHECK'}  {ref['doi']}")
        for i in open_issues:
            print('      ' + i)
        for i in acked:
            print(f"      (acknowledged) {i} -- {ref.get('note', '')}")
        bad += bool(open_issues)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'script/references.json')
