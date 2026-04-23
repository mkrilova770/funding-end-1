"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ExchangeIcon,
  isExchangeAdapterSlug,
} from "@/lib/exchanges/exchange-icon";
import { EXCHANGE_LABELS } from "@/lib/exchanges/labels";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { cn } from "@/lib/utils";
import {
  type ColumnId,
  columnTitle,
  useFundingUiStore,
} from "@/features/funding-table/funding-ui-store";

function labelFor(id: ColumnId): string {
  if (id === "coins" || id === "maxSpread") {
    return columnTitle(id);
  }
  return EXCHANGE_LABELS[id as ExchangeAdapterSlug];
}

function SortableRow({ id }: { id: ColumnId }) {
  const visibility = useFundingUiStore((s) => s.columnVisibility);
  const toggle = useFundingUiStore((s) => s.toggleColumnVisibility);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: id === "coins" });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const locked = id === "coins";
  const visible = visibility[id] ?? true;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2",
        isDragging && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            id === "coins" && "cursor-not-allowed opacity-40",
          )}
          aria-label="Перетащить"
          {...attributes}
          {...listeners}
          disabled={id === "coins"}
        >
          <GripVertical className="size-4" />
        </button>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {isExchangeAdapterSlug(id) ? (
            <div className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border bg-background">
              <ExchangeIcon
                slug={id}
                className="size-5"
                title={labelFor(id)}
              />
            </div>
          ) : null}
          <span className="min-w-0 truncate">{labelFor(id)}</span>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={locked}
        onClick={() => toggle(id)}
        aria-label={visible ? "Скрыть колонку" : "Показать колонку"}
      >
        {locked ? (
          <EyeOff className="size-4" />
        ) : visible ? (
          <Eye className="size-4" />
        ) : (
          <EyeOff className="size-4" />
        )}
      </Button>
    </div>
  );
}

export function ColumnSettingsDialog() {
  const open = useFundingUiStore((s) => s.settingsOpen);
  const setOpen = useFundingUiStore((s) => s.setSettingsOpen);
  const order = useFundingUiStore((s) => s.columnOrder);
  const reorder = useFundingUiStore((s) => s.reorderColumns);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const active = event.active.id as ColumnId;
    const over = event.over?.id as ColumnId | undefined;
    if (!over) return;
    reorder(active, over);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Настройки колонок"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={(v) => setOpen(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройки колонок</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Перетащите строки, чтобы изменить порядок колонок и видимость бирж.
          </p>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto pr-1">
                {order.map((id) => (
                  <SortableRow key={id} id={id} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </DialogContent>
      </Dialog>
    </>
  );
}
