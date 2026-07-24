import { useCallback, useEffect, useRef, useState } from "react";
import { Thumbnail } from "@/components/shared/thumbnail";
import { ShelfCard, ShelfItemActivator } from "@/components/shared/shelf-card";
import { cn } from "@/lib/utils";
import type { Shelf, ShelfItem } from "@/lib/innertube/types";

/**
 * Cover-flow shelf: the selected cover faces the viewer, its neighbours
 * angle away into the distance on either side, and the title of
 * whatever is centered sits underneath.
 *
 * Why this shape on this app: the Pi's 1920x440 panel is very wide and
 * very short. A flat row of cards wastes the width on small covers, and
 * a card's own title block costs vertical space the panel doesn't have.
 * Cover flow spends the width instead — one big, readable cover in the
 * middle, everything else compressed into the sides, and a single
 * shared title line.
 *
 * Performance: only `transform` and `opacity` animate, so every cover
 * stays on its own compositor layer and the Pi's V3D GPU never
 * re-rasterizes during a flick. Deliberately NOT included: the mirrored
 * reflection of the original Cover Flow — it doubles the texture memory
 * and per-frame blend work for something largely invisible against a
 * dark background.
 */

/** Covers rendered on each side of center. Beyond this they'd be fully
 *  occluded anyway, so they're dropped from the DOM entirely. Six is
 *  what it takes to fill a 1920px-wide panel at the spacing below. */
const VISIBLE_SIDE = 6;

/** Fraction of the cover's width that the first side cover is offset
 *  by, then each subsequent one. The first step is larger so the
 *  centered cover reads as separated from the stack. */
const FIRST_OFFSET = 0.72;
const STEP_OFFSET = 0.3;

/** Rotation of the side covers, in degrees. */
const ANGLE = 58;

/** Drag distance (px) that advances one cover. */
const DRAG_STEP = 90;

export function CoverFlow({ shelf }: { shelf: Shelf }) {
  const items = shelf.items;
  const [index, setIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(items.length - 1, i)),
    [items.length],
  );

  // A new page of shelves can replace the items under us; snap back
  // rather than pointing past the end.
  useEffect(() => {
    setIndex((i) => Math.max(0, Math.min(items.length - 1, i)));
  }, [items.length]);

  // Horizontal wheel / trackpad swipe moves the selection. Vertical
  // wheel is deliberately left alone so the page still scrolls when the
  // pointer happens to be over a shelf.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      acc += e.deltaX;
      const steps = Math.trunc(acc / 40);
      if (steps !== 0) {
        acc -= steps * 40;
        setIndex((i) => clamp(i + steps));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clamp]);

  // Drag / swipe. `moved` doubles as the click guard: a flick that ends
  // over a cover must not also open it.
  const drag = useRef({ active: false, startX: 0, startIndex: 0, moved: false });
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = {
      active: true,
      startX: e.clientX,
      startIndex: index,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) > 6) {
      d.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (d.moved) setIndex(clamp(d.startIndex - Math.round(dx / DRAG_STEP)));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    drag.current.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  if (items.length === 0) return null;

  // `category` shelves are pill lists, not artwork — a 3D carousel of
  // text tiles would be worse than the row they already have.
  if (items.every((i) => i.kind === "category")) {
    return <CategoryShelf shelf={shelf} />;
  }

  const active = items[index];

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="truncate text-xl font-semibold tracking-tight short:text-base">
          {shelf.title}
        </h2>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {index + 1} / {items.length}
        </span>
      </div>

      <div
        ref={viewportRef}
        role="listbox"
        aria-label={shelf.title}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            setIndex((i) => clamp(i + 1));
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setIndex((i) => clamp(i - 1));
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="cover-flow relative touch-pan-y select-none outline-none"
      >
        {items.map((item, i) => {
          const offset = i - index;
          if (Math.abs(offset) > VISIBLE_SIDE) return null;
          return (
            <CoverFlowItem
              key={`${item.kind}:${item.id}`}
              item={item}
              offset={offset}
              onSelect={() => setIndex(i)}
              wasDragged={() => drag.current.moved}
            />
          );
        })}
      </div>

      <div className="flex min-h-[2.5rem] flex-col items-center px-1 text-center">
        <span className="max-w-full truncate text-sm font-medium">
          {active.title}
        </span>
        <span className="max-w-full truncate text-xs text-muted-foreground">
          {active.subtitle ??
            active.artists?.map((a) => a.name).join(", ") ??
            active.album ??
            ""}
        </span>
      </div>
    </section>
  );
}

function CoverFlowItem({
  item,
  offset,
  onSelect,
  wasDragged,
}: {
  item: ShelfItem;
  offset: number;
  onSelect: () => void;
  /** Read at click time — a click that ends a drag must not open. */
  wasDragged: () => boolean;
}) {
  const centered = offset === 0;
  const dir = Math.sign(offset);
  const depth = Math.abs(offset);

  // Side covers fan out from the centered one and tilt away from the
  // viewer. `translateZ` pushes them back so they tuck *behind* their
  // inner neighbour rather than intersecting it.
  const x = centered
    ? 0
    : dir * (FIRST_OFFSET + (depth - 1) * STEP_OFFSET) * 100;
  const z = centered ? 0 : -60 - depth * 24;
  const rotate = centered ? 0 : -dir * ANGLE;

  return (
    <div
      className="cover-flow-slot"
      style={{
        transform: `translate(-50%, 0) translate3d(${x}%, 0, ${z}px) rotateY(${rotate}deg)`,
        zIndex: 100 - depth,
        // The stack darkens with distance, which reads as depth without
        // costing a filter or a second layer.
        opacity: depth >= VISIBLE_SIDE ? 0 : 1,
      }}
    >
      {centered ? (
        <ShelfItemActivator
          item={item}
          className="block size-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Cover item={item} centered />
        </ShelfItemActivator>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={item.title}
          onClick={(e) => {
            if (wasDragged()) {
              e.preventDefault();
              return;
            }
            onSelect();
          }}
          className="block size-full cursor-pointer rounded-lg outline-none"
        >
          <Cover item={item} centered={false} />
        </button>
      )}
    </div>
  );
}

function Cover({ item, centered }: { item: ShelfItem; centered: boolean }) {
  return (
    <div className="relative size-full">
      <Thumbnail
        thumbnails={item.thumbnails}
        alt={item.title}
        round={item.round}
        className={cn(
          "size-full",
          item.round ? "rounded-full" : "rounded-lg",
          centered ? "shadow-2xl" : "shadow-lg",
        )}
        targetSize={512}
        highRes
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 border border-hairline",
          item.round ? "rounded-full" : "rounded-lg",
          // Everything off-center is dimmed, so the eye lands on the
          // selected cover even mid-flick.
          !centered && "bg-black/45",
        )}
      />
    </div>
  );
}

/** Moods & genres arrive as `category` pills; keep the flat row. */
function CategoryShelf({ shelf }: { shelf: Shelf }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="truncate px-1 text-xl font-semibold tracking-tight short:text-base">
        {shelf.title}
      </h2>
      <div className="shelf-scroll flex min-w-0 gap-2 overflow-x-auto overflow-y-hidden pb-2">
        {shelf.items.map((item) => (
          <div key={`${item.kind}:${item.id}`} className="w-64 shrink-0">
            <ShelfCard item={item} />
          </div>
        ))}
      </div>
    </section>
  );
}
