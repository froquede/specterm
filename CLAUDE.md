# specterm

## UI rules

- No Unicode glyphs or emoji as icons (no `⚡`, `▲`, `●`, `🔋`, box-drawing
  characters and the like). Use a real icon from `lucide-solid`, exported through
  `src/lib/icons.ts` (eager chrome) or `src/lib/icons-lazy.ts` (lazily mounted
  panels).
- Align icons optically, not mathematically. Centring the icon's box on the
  text is only the starting point: size it so the drawn shape matches the
  text's cap height, and measure gaps from the visible edge of the shape (a
  battery's nub, an arrow's tip), not from its bounding box. Check it in a
  zoomed screenshot before calling it done.
