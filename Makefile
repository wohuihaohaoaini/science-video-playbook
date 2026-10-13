PY := .venv/bin/python

.PHONY: setup assets voice durations refs preflight prepare preview still sample full music mix check all clean

setup:            ## create .venv and install Python deps (no system changes, no Chromium download)
	python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt

assets:           ## fonts (OFL) + example photos (Wikimedia Commons)
	$(PY) tools/fetch_assets.py fonts && $(PY) tools/fetch_assets.py photos

voice:            ## synthesize missing voice lines (normally run by the voice agent)
	$(PY) tools/tts_edge.py

durations:        ## measure voice files -> build/vo_durations.json
	$(PY) tools/vo_durations.py

refs:             ## check every DOI against Crossref
	$(PY) tools/verify_doi.py script/references.json

preflight:        ## Chrome, VideoToolbox, fonts, photos, voice files
	$(PY) tools/preflight.py

prepare: durations ## export the browser timeline + cover, then regenerate music
	cd pipeline && ../$(PY) render.py prepare && ../$(PY) music.py

preview:          ## scrub the film in a browser: http://127.0.0.1:8765/scenes/index.html?preview=1
	$(PY) -m http.server 8765 --bind 127.0.0.1

still:            ## one frame: make still T=75
	cd pipeline && ../$(PY) render.py still --t $(T)

sample:           ## 10 s from a scene: make sample SCENE=S3
	cd pipeline && ../$(PY) render.py sample --scene $(or $(SCENE),S3)

full:             ## whole film (needs build/sample_review.json status=passed)
	cd pipeline && ../$(PY) render.py full

music:
	cd pipeline && ../$(PY) music.py

mix:              ## VO + ducked music + SFX, two-pass loudnorm, mux, SRT
	cd pipeline && ../$(PY) mix.py

check:            ## specs, frame count, loudness, review frames
	cd pipeline && ../$(PY) check.py

all: preflight prepare sample   ## then review the sample, mark it passed, and run: make full mix check

clean:
	rm -rf build/film_parts build/sample_parts build/check build/stills
