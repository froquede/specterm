interface SplitHandleProps {
  direction: "h" | "v";
  onDrag: (delta: number, totalSize: number) => void;
}

export default function SplitHandle(props: SplitHandleProps) {
  let handleRef!: HTMLDivElement;

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    handleRef.setPointerCapture(e.pointerId);

    const parent = handleRef.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const isHorizontal = props.direction === "h";
    let rafId: number | null = null;

    function onPointerMove(e: PointerEvent) {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const pos = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top;
        const total = isHorizontal ? rect.width : rect.height;
        props.onDrag(pos, total);
      });
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
      onPointerDown={onPointerDown}
    />
  );
}
