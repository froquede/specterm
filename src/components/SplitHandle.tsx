export interface ResizeEntry {
  splitId: string;
  ratio: number;
}

interface SplitHandleProps {
  direction: "h" | "v";
  splitId: string;
  // Emits one entry per split node the drag touches. A plain drag moves every
  // handle sitting on the same "snapped" divider line (so a full row/column
  // resizes together); Alt-drag narrows it to this single split.
  onResize: (entries: ResizeEntry[]) => void;
  onToggleDirection?: () => void;
}

// How close two handles' shared line must be (in px) to count as aligned, and
// how large a gap along that line still reads as one continuous divider. The
// bridging tolerance has to clear the perpendicular handle (4px) that sits
// between two stacked segments where they meet.
const CROSS_TOL = 6;
const GAP_TOL = 14;

export default function SplitHandle(props: SplitHandleProps) {
  let handleRef!: HTMLDivElement;

  // Every split handle that lies on the same straight line as this one and is
  // connected to it — i.e. the whole "snapped" divider a user perceives as a
  // single line even though the tree stores it as several independent splits.
  function gatherGroup(): Array<{ el: HTMLElement; splitId: string }> {
    const self = { el: handleRef, splitId: props.splitId };
    const root = handleRef.closest("[data-split-root]");
    if (!root) return [self];

    const horizontal = props.direction === "h"; // vertical bar, col-resize
    // Cross-axis: the coordinate that stays constant along the divider line.
    const cross = (r: DOMRect) =>
      horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
    // Main-axis span: the extent the divider covers along its own line.
    const lo = (r: DOMRect) => (horizontal ? r.top : r.left);
    const hi = (r: DOMRect) => (horizontal ? r.bottom : r.right);

    const all = Array.from(
      root.querySelectorAll<HTMLElement>(`.split-handle-${props.direction}`)
    ).map((el) => ({ el, rect: el.getBoundingClientRect(), splitId: el.dataset.splitId! }));

    const selfEntry = all.find((h) => h.el === handleRef);
    if (!selfEntry) return [self];

    const aligned = all.filter(
      (h) => Math.abs(cross(h.rect) - cross(selfEntry.rect)) <= CROSS_TOL
    );

    // Grow the group outward from self, linking any aligned segment whose span
    // touches (within GAP_TOL) a segment already in the group. Transitive, so a
    // divider spanning three or more stacked splits links all of them.
    const group = [selfEntry];
    for (let changed = true; changed; ) {
      changed = false;
      for (const cand of aligned) {
        if (group.includes(cand)) continue;
        const connects = group.some(
          (g) => lo(cand.rect) <= hi(g.rect) + GAP_TOL && hi(cand.rect) >= lo(g.rect) - GAP_TOL
        );
        if (connects) {
          group.push(cand);
          changed = true;
        }
      }
    }
    return group.map((h) => ({ el: h.el, splitId: h.splitId }));
  }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    handleRef.setPointerCapture(e.pointerId);

    const horizontal = props.direction === "h";
    // Alt confines the drag to this split; a plain drag moves the whole line.
    const group = e.altKey ? [{ el: handleRef, splitId: props.splitId }] : gatherGroup();
    // Cache each member's owning container — the flex parent whose size turns an
    // absolute pointer coordinate into that split's ratio. Members can differ in
    // size, so each is measured against its own container every frame.
    const members = group
      .map((g) => ({ splitId: g.splitId, parent: g.el.parentElement }))
      .filter((m): m is { splitId: string; parent: HTMLElement } => !!m.parent);

    let rafId: number | null = null;
    let pointer = 0;

    function apply() {
      rafId = null;
      const entries: ResizeEntry[] = members.map((m) => {
        const rect = m.parent.getBoundingClientRect();
        const ratio = horizontal
          ? (pointer - rect.left) / rect.width
          : (pointer - rect.top) / rect.height;
        return { splitId: m.splitId, ratio };
      });
      props.onResize(entries);
    }

    function onPointerMove(ev: PointerEvent) {
      pointer = horizontal ? ev.clientX : ev.clientY;
      if (rafId) return;
      rafId = requestAnimationFrame(apply);
    }

    function onPointerUp() {
      if (rafId) cancelAnimationFrame(rafId);
      handleRef.removeEventListener("pointermove", onPointerMove);
      handleRef.removeEventListener("pointerup", onPointerUp);
      handleRef.removeEventListener("pointercancel", onPointerUp);
    }

    handleRef.addEventListener("pointermove", onPointerMove);
    handleRef.addEventListener("pointerup", onPointerUp);
    handleRef.addEventListener("pointercancel", onPointerUp);
  }

  return (
    <div
      ref={handleRef}
      class={`split-handle split-handle-${props.direction}`}
      data-split-id={props.splitId}
      onPointerDown={onPointerDown}
    >
      <button
        class="split-flip"
        title="Toggle split direction"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleDirection?.();
        }}
      >
        ⇄
      </button>
    </div>
  );
}
