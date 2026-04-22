# Banner Margin Adjustment

This note documents the margin refinement used for `banner-opaque.png`.

## Goal

The previous banner crop had a bottom margin that still looked larger than the top margin. The fix keeps the top crop unchanged and removes a small amount of whitespace from the bottom only.

## Method

- Source image: `logos/Gemini_Generated_Image_kuyg34kuyg34kuyg.png`.
- Processing tool: Node.js with Playwright canvas APIs.
- Output image: `logos/banner-opaque.png`.
- Canvas operation: crop the original image at full width with a fixed top offset and reduced height.

## Values Used

- Source size: `2048 x 2048`.
- Previous output size: `2048 x 700`.
- New output size: `2048 x 670`.
- Crop x: `0 px`.
- Crop y: `685 px`.
- Crop width: `2048 px`.
- Crop height: `670 px`.
- Bottom reduction from previous crop: `30 px`.
- Left/right crop: unchanged, full width preserved.

## Result

The final banner keeps the logo and text placement intact while reducing the bottom margin so it visually balances better with the top margin.
