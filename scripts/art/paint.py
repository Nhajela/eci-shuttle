"""Paint the ECI Shuttle art with the image model. Prompts live in prompts.py.

    secrets run -- uv run --with pillow python3 scripts/art/paint.py hero-wide --n 3
    secrets run -- uv run --with pillow python3 scripts/art/paint.py            # every subject, one each

Writes /tmp/eci-art/raw/<name>-<k>.png (never into the repo). A person reads every candidate
before compose.py uses it: no lettering, no logos, no mangled hands or faces, the right vehicle.

The key is read from the environment (GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT) and is never printed,
and neither is the address, which carries it. It is a Vertex key: the call goes to
aiplatform.googleapis.com with the project in the path.
"""

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompts import SUBJECTS  # noqa: E402

RAW = "/tmp/eci-art/raw"
MODEL = "gemini-3-pro-image"


def address():
    key = os.environ["GEMINI_API_KEY"]
    project = os.environ["GOOGLE_CLOUD_PROJECT"]
    return (
        "https://aiplatform.googleapis.com/v1/projects/%s/locations/global/"
        "publishers/google/models/%s:generateContent?key=%s" % (project, MODEL, key)
    )


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def paint(entry, refs):
    parts = [{"inlineData": {"mimeType": "image/png", "data": b64(ref)}} for ref in refs]
    parts.append({"text": entry["prompt"]})
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": entry["aspect"], "imageSize": entry.get("size", "2K")},
        },
    }
    request = urllib.request.Request(
        address(),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    answer = None
    for attempt in range(8):
        try:
            with urllib.request.urlopen(request, timeout=300) as res:
                answer = json.loads(res.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as err:
            text = err.read().decode("utf-8", "replace")
            if err.code in (429, 500, 503) and attempt < 7:
                print("  busy (%s), waiting a minute" % err.code, flush=True)
                time.sleep(60)
                continue
            # Never print the address, which holds the key.
            raise SystemExit("the model refused: %s %s" % (err.code, text[:600]))
        except urllib.error.URLError as err:
            raise SystemExit("could not reach the model: %s" % err.reason)
    for candidate in answer.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            data = part.get("inlineData", {}).get("data")
            if data:
                return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")
    raise SystemExit("no picture came back: %s" % json.dumps(answer)[:600])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--n", type=int, default=1, help="candidates per subject")
    ap.add_argument("--ref", action="append", default=[], help="style reference image(s)")
    ap.add_argument("--start", type=int, default=0, help="first candidate index")
    args = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    for name in args.names or list(SUBJECTS):
        if name not in SUBJECTS:
            raise SystemExit("no subject is called %s, see prompts.py" % name)
        entry = SUBJECTS[name]
        refs = args.ref or entry.get("refs", [])
        for k in range(args.start, args.start + args.n):
            out = os.path.join(RAW, "%s-%d.png" % (name, k))
            print("painting", name, k, flush=True)
            try:
                raw = paint(entry, refs)
            except SystemExit as err:
                print("  failed:", err, flush=True)
                continue
            raw.save(out)
            print("  ", raw.size, out, flush=True)
    print("done. read each one before compose.py uses it.", flush=True)


if __name__ == "__main__":
    main()
