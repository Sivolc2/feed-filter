"""Assembles tests/frames/*.png (named NN_milliseconds.png) into docs/demo.gif."""
import pathlib
from PIL import Image

here = pathlib.Path(__file__).parent
frames = sorted((here / "frames").glob("*.png"))
images = [Image.open(f).convert("RGB").resize((800, 512), Image.LANCZOS) for f in frames]
palette = images[1].quantize(colors=128, method=Image.MEDIANCUT)
images = [im.quantize(palette=palette, dither=Image.NONE) for im in images]
images[0].save(here.parent / "docs" / "demo.gif", save_all=True, append_images=images[1:], duration=[int(f.stem.split("_")[1]) for f in frames], loop=0, optimize=True)
print("docs/demo.gif", (here.parent / "docs" / "demo.gif").stat().st_size // 1024, "KB")
