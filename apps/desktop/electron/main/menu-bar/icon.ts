import { nativeImage } from "electron";

/** The existing logo's two lanes and sparkle, without its square background. */
export function menuBarIcon() {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = 18 * scaleFactor;
    const buffer = Buffer.alloc(size * size * 4);
    // Supersample the silhouette for clean edges at both menu-bar densities.
    const inside = (x: number, y: number) => {
      const top = y >= 127 && y <= 153 && x >= 81 && x <= 431;
      const lane = (left: number, bottom: number) =>
        x >= left &&
        x <= left + 96.25 &&
        y >= 140 &&
        (y <= bottom - 30 ||
          (y <= bottom && x >= left + 30 && x <= left + 66.25) ||
          (y > bottom - 30 &&
            Math.hypot(
              x - Math.max(left + 30, Math.min(left + 66.25, x)),
              y - (bottom - 30),
            ) <= 30));
      const sparkle = Math.abs(x - 191.5) / 30 + Math.abs(y - 377) / 31 <= 1;
      return top || lane(137.875, 297.648) || lane(286.625, 385.148) || sparkle;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let covered = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            if (
              inside(
                64 + ((x + (sx + 0.5) / 4) / size) * 384,
                64 + ((y + (sy + 0.5) / 4) / size) * 384,
              )
            )
              covered++;
          }
        }
        buffer[(y * size + x) * 4 + 3] = Math.round((covered * 255) / 16);
      }
    }
    const bitmap = nativeImage.createFromBitmap(buffer, {
      width: size,
      height: size,
    });
    image.addRepresentation({ scaleFactor, dataURL: bitmap.toDataURL() });
  }
  image.setTemplateImage(true);
  return image;
}
