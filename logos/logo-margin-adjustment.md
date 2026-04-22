# Logo Margin Adjustment

This note documents the margin refinement used for `gemini-opaque.png`.

## Goal

The original logo crop had visibly tighter spacing on the top and right edges than on the left and bottom edges. The fix keeps the existing left and bottom margins unchanged, then adds matching padding to the top and right sides.

## Method

- Source image: committed `logos/gemini-opaque.png` before this adjustment.
- Processing tool: Node.js with Playwright canvas APIs.
- Output image: `logos/gemini-opaque.png`.
- Canvas operation: create a larger canvas, fill it with a sampled background color, then draw the original logo shifted down.

## Values Used

- Original size: `1333 x 1212`.
- New size: `1363 x 1242`.
- Top padding added: `30 px`.
- Right padding added: `30 px`.
- Left padding added: `0 px`.
- Bottom padding added: `0 px`.
- Background sample area: first `10 px` rows of the original image.
- Sampled background color: `rgb(246, 252, 246)`.

## Result

The final image keeps the original artwork intact while making the top and right margins visually closer to the existing bottom and left margins.
