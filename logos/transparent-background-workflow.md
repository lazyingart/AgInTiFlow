# Transparent Logo Workflow

This note documents how the transparent logo assets were produced and compressed so the same method can become a reusable agent image-edit tool later.

## Asset Naming

- `gemini-opaque.png`: original non-transparent Gemini logo crop.
- `gemini-trans.png`: transparent cutout produced from the Gemini logo.
- `doubao.png`: original Doubao candidate image.
- `doubao-trans.png`: transparent cutout produced from the Doubao candidate.
- `logo.png`: current app-facing transparent logo, compressed from `doubao-trans.png` to stay under 1 MB.

## Tools Used

- Python 3.10 in a temporary virtual environment: `/tmp/aginti-bgremove-venv`.
- `rembg` for model-based background removal.
- `onnxruntime` for local CPU inference.
- `Pillow` for PNG IO, cropping, resizing, and compression.
- `numpy` and `scipy.ndimage` for alpha-mask cleanup.
- `u2net.onnx` background-removal model cached at `~/.u2net/u2net.onnx`.
- Visual QA with the local image viewer after each output.

No sudo was required. The setup stayed user-local.

## Environment Setup

```bash
VENV=/tmp/aginti-bgremove-venv

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install rembg pillow numpy onnxruntime

mkdir -p ~/.u2net
curl -L --fail --retry 5 --retry-delay 2 \
  -o ~/.u2net/u2net.onnx \
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
```

## Background Removal Pass

The first pass uses `rembg` with alpha matting. These values worked well for the glossy logo on a white background:

- `alpha_matting_foreground_threshold=245`
- `alpha_matting_background_threshold=12`
- `alpha_matting_erode_size=6`

```python
from PIL import Image
from rembg import remove, new_session

session = new_session("u2net")
outputs = [
    ("logos/gemini-opaque.png", "logos/gemini-trans.png"),
    ("logos/doubao.png", "logos/doubao-trans.png"),
]

for src, dst in outputs:
    image = Image.open(src).convert("RGBA")
    result = remove(
        image,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=245,
        alpha_matting_background_threshold=12,
        alpha_matting_erode_size=6,
    ).convert("RGBA")
    result.save(dst, optimize=True)
    print(f"{dst}: size={result.size} bbox={result.getbbox()}")
```

## Alpha Cleanup Pass

The model kept some large near-white interior/background regions. The cleanup pass removes connected near-white components that touch the canvas border or exceed a size threshold, while preserving smaller metallic highlights.

Values used:

- Near-white test: all RGB channels `> 232`.
- Low-saturation test: `max(rgb) - min(rgb) < 36`.
- Minimum removable component area: `3500` pixels for `gemini-trans.png`, `7000` pixels for `doubao-trans.png`.

```python
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

configs = {
    "logos/gemini-trans.png": 3500,
    "logos/doubao-trans.png": 7000,
}

for path, min_area in configs.items():
    image = Image.open(path).convert("RGBA")
    arr = np.array(image)
    rgb = arr[:, :, :3].astype(np.int16)
    alpha = arr[:, :, 3]

    high = (rgb[:, :, 0] > 232) & (rgb[:, :, 1] > 232) & (rgb[:, :, 2] > 232)
    low_sat = (rgb.max(axis=2) - rgb.min(axis=2)) < 36
    near_white = high & low_sat & (alpha > 0)

    labels, count = ndi.label(near_white)
    if count:
        areas = np.bincount(labels.ravel())
        border_labels = np.unique(
            np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
        )

        remove = np.zeros(count + 1, dtype=bool)
        remove[border_labels] = True
        remove |= areas > min_area
        remove[0] = False

        alpha[remove[labels]] = 0

    arr[:, :, 3] = alpha
    Image.fromarray(arr, "RGBA").save(path, optimize=True)
```

## App Logo Compression

`logo.png` is generated from `doubao-trans.png`, cropped to the alpha bounding box with `48 px` padding, then resized until the optimized PNG is below `1,000,000` bytes.

Final output used:

- Size: `960 x 871`.
- File size: `946,437` bytes.
- Copied to `docs/assets/aginti-logo.png` in the AgInTi landing site for favicon and page logo use.

```python
from pathlib import Path
from PIL import Image

source = Path("logos/doubao-trans.png")
outputs = [
    Path("logos/logo.png"),
    Path("/home/lachlan/ProjectsLFS/Agent/AgInTiLanding/docs/assets/aginti-logo.png"),
]
max_bytes = 1_000_000
source_image = Image.open(source).convert("RGBA")
bbox = source_image.getchannel("A").getbbox()
if not bbox:
    raise SystemExit("source has no alpha content")

pad = 48
left = max(0, bbox[0] - pad)
top = max(0, bbox[1] - pad)
right = min(source_image.width, bbox[2] + pad)
bottom = min(source_image.height, bbox[3] + pad)
base = source_image.crop((left, top, right, bottom))

selected = None
for max_dim in [1280, 1180, 1080, 1024, 960, 900, 840, 768]:
    image = base.copy()
    scale = min(1.0, max_dim / max(image.size))
    if scale < 1.0:
        image = image.resize(
            (round(image.width * scale), round(image.height * scale)),
            Image.Resampling.LANCZOS,
        )

    tmp = Path("/tmp/aginti-logo-candidate.png")
    image.save(tmp, optimize=True, compress_level=9)
    size = tmp.stat().st_size
    print(f"candidate max_dim={max_dim} size={image.size} bytes={size}")
    if size < max_bytes:
        selected = image
        break

if selected is None:
    selected = image
    print("warning: could not reach target under 1MB")

for output in outputs:
    output.parent.mkdir(parents=True, exist_ok=True)
    selected.save(output, optimize=True, compress_level=9)
    print(f"wrote {output} {selected.size} {output.stat().st_size} bytes")
```

## Future Agent Tool Shape

A reusable image-edit agent tool should wrap this as guarded operations:

- `remove_background(input, output, model="u2net", alpha_matting=true)`.
- `cleanup_white_components(input, output, rgb_threshold=232, saturation_delta=36, min_area=3500)`.
- `compress_png(input, output, max_bytes=1000000, pad=48, max_dims=[1280,1180,1080,1024,960])`.
- `sync_asset(source, destinations[])` for app favicon/logo copies.

Safety rules:

- Do not use sudo for image processing; use a project or temp venv.
- Do not overwrite source images; write sibling outputs unless explicitly requested.
- Verify alpha bounding box and file size after each run.
- Treat generated-watermark removal carefully: prefer extracting the intended foreground into a transparent asset rather than inpainting provenance text into a new opaque image.
